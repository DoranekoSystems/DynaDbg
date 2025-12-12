/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║           STELLAR DEFENDER - Terminal Shooting Game                       ║
 * ║                  A DynaDbg Benchmark Application                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * This game is designed for memory debugging and analysis testing.
 * Features:
 *   - Multi-threaded clock_gettime calls for timing analysis
 *   - Multi-threaded memory access patterns for HP/Score
 *   - Pause/Resume functionality via commands
 *   - Memory address display for debugging tools
 *
 * Build: g++ -g -O0 -std=c++17 -pthread -lncurses -o shooting_game shooting_game.cpp
 */

#include <ncurses.h>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <atomic>
#include <chrono>
#include <random>
#include <cmath>
#include <cstring>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <unistd.h>
#include <time.h>

// ============================================================================
// GLOBAL GAME STATE (Exposed for memory debugging)
// ============================================================================

// Primary game variables - these addresses are displayed for debugging
volatile int32_t g_score = 0;
volatile int32_t g_player_hp = 100;
volatile int32_t g_max_hp = 100;
volatile int32_t g_level = 1;
volatile int32_t g_enemies_killed = 0;
volatile int32_t g_bullets_fired = 0;
volatile int32_t g_combo_count = 0;
volatile int32_t g_high_score = 0;
volatile int64_t g_play_time_ms = 0;

// Game control flags
std::atomic<bool> g_game_running{true};
std::atomic<bool> g_game_paused{false};
std::atomic<bool> g_game_over{false};
std::atomic<bool> g_show_title{true};

// Thread synchronization
std::mutex g_state_mutex;
std::mutex g_render_mutex;

// ============================================================================
// COLOR DEFINITIONS
// ============================================================================

enum Colors
{
    COLOR_PAIR_DEFAULT = 1,
    COLOR_PAIR_PLAYER,
    COLOR_PAIR_PLAYER_SHIELD,
    COLOR_PAIR_BULLET,
    COLOR_PAIR_ENEMY_WEAK,
    COLOR_PAIR_ENEMY_NORMAL,
    COLOR_PAIR_ENEMY_STRONG,
    COLOR_PAIR_ENEMY_BOSS,
    COLOR_PAIR_EXPLOSION,
    COLOR_PAIR_POWERUP,
    COLOR_PAIR_UI_NORMAL,
    COLOR_PAIR_UI_WARNING,
    COLOR_PAIR_UI_DANGER,
    COLOR_PAIR_UI_HIGHLIGHT,
    COLOR_PAIR_TITLE,
    COLOR_PAIR_STAR_DIM,
    COLOR_PAIR_STAR_BRIGHT,
    COLOR_PAIR_DEBUG_INFO,
};

// ============================================================================
// GAME ENTITY STRUCTURES
// ============================================================================

struct Vec2
{
    float x, y;
    Vec2(float x = 0, float y = 0) : x(x), y(y) {}
};

struct Bullet
{
    Vec2 pos;
    Vec2 velocity;
    bool active = false;
    int damage = 10;
    char symbol = '-';
    int color = COLOR_PAIR_BULLET;
};

struct Enemy
{
    Vec2 pos;
    Vec2 velocity;
    bool active = false;
    int hp = 10;
    int max_hp = 10;
    int score_value = 100;
    int type = 0; // 0=weak, 1=normal, 2=strong, 3=boss
    std::string sprite;
    int color = COLOR_PAIR_ENEMY_NORMAL;
    int fire_cooldown = 0;
    float amplitude = 0; // For wave movement
    float phase = 0;
    float base_y = 0;
};

struct EnemyBullet
{
    Vec2 pos;
    Vec2 velocity;
    bool active = false;
    int damage = 5;
    char symbol = '*';
};

struct Explosion
{
    Vec2 pos;
    int frame = 0;
    int max_frames = 8;
    bool active = false;
};

struct Powerup
{
    Vec2 pos;
    Vec2 velocity;
    bool active = false;
    int type = 0; // 0=heal, 1=shield, 2=weapon
    char symbol = '+';
};

struct Star
{
    Vec2 pos;
    float speed;
    char symbol;
    int brightness; // 0=dim, 1=bright
};

struct Player
{
    Vec2 pos;
    int width = 5;
    int height = 3;
    int fire_cooldown = 0;
    int shield = 0;
    int weapon_level = 1;
    bool invincible = false;
    int invincible_timer = 0;

    // Player ship sprite (multi-line)
    const char *sprite[3] = {
        "  /=>",
        "<=###",
        "  \\=>"};
};

// ============================================================================
// GAME CLASS
// ============================================================================

class StellarDefender
{
private:
    Player player;
    std::vector<Bullet> bullets;
    std::vector<Enemy> enemies;
    std::vector<EnemyBullet> enemy_bullets;
    std::vector<Explosion> explosions;
    std::vector<Powerup> powerups;
    std::vector<Star> stars;

    int screen_width = 80;
    int screen_height = 24;
    int game_area_width = 60;
    int game_area_height = 20;
    int ui_panel_x = 62;

    std::mt19937 rng;
    int frame_count = 0;
    int enemy_spawn_timer = 0;
    int difficulty_timer = 0;

    // Double buffering to prevent flicker
    WINDOW *game_win = nullptr;
    WINDOW *ui_win = nullptr;

    // Timing threads
    std::vector<std::thread> clock_threads;
    std::vector<std::thread> memory_threads;
    std::atomic<int64_t> clock_call_count{0};
    std::atomic<int64_t> memory_read_count{0};

public:
    StellarDefender() : rng(std::random_device{}())
    {
        bullets.resize(50);
        enemies.resize(30);
        enemy_bullets.resize(100);
        explosions.resize(20);
        powerups.resize(10);
    }

    ~StellarDefender()
    {
        stopThreads();
        if (game_win)
            delwin(game_win);
        if (ui_win)
            delwin(ui_win);
    }

    void init()
    {
        // Initialize ncurses
        initscr();
        cbreak();
        noecho();
        keypad(stdscr, TRUE);
        nodelay(stdscr, TRUE);
        curs_set(0);

        // Get screen size
        getmaxyx(stdscr, screen_height, screen_width);
        game_area_width = std::min(60, screen_width - 22);
        game_area_height = std::min(20, screen_height - 4);
        ui_panel_x = game_area_width + 2;

        // Initialize colors
        if (has_colors())
        {
            start_color();
            use_default_colors();

            init_pair(COLOR_PAIR_DEFAULT, COLOR_WHITE, -1);
            init_pair(COLOR_PAIR_PLAYER, COLOR_CYAN, -1);
            init_pair(COLOR_PAIR_PLAYER_SHIELD, COLOR_BLUE, -1);
            init_pair(COLOR_PAIR_BULLET, COLOR_YELLOW, -1);
            init_pair(COLOR_PAIR_ENEMY_WEAK, COLOR_GREEN, -1);
            init_pair(COLOR_PAIR_ENEMY_NORMAL, COLOR_YELLOW, -1);
            init_pair(COLOR_PAIR_ENEMY_STRONG, COLOR_RED, -1);
            init_pair(COLOR_PAIR_ENEMY_BOSS, COLOR_MAGENTA, -1);
            init_pair(COLOR_PAIR_EXPLOSION, COLOR_RED, -1);
            init_pair(COLOR_PAIR_POWERUP, COLOR_GREEN, -1);
            init_pair(COLOR_PAIR_UI_NORMAL, COLOR_WHITE, -1);
            init_pair(COLOR_PAIR_UI_WARNING, COLOR_YELLOW, -1);
            init_pair(COLOR_PAIR_UI_DANGER, COLOR_RED, -1);
            init_pair(COLOR_PAIR_UI_HIGHLIGHT, COLOR_CYAN, -1);
            init_pair(COLOR_PAIR_TITLE, COLOR_CYAN, -1);
            init_pair(COLOR_PAIR_STAR_DIM, COLOR_BLUE, -1);
            init_pair(COLOR_PAIR_STAR_BRIGHT, COLOR_WHITE, -1);
            init_pair(COLOR_PAIR_DEBUG_INFO, COLOR_MAGENTA, -1);
        }

        // Create windows (for double buffering effect)
        game_win = newwin(game_area_height + 2, game_area_width + 2, 1, 0);
        ui_win = newwin(game_area_height + 2, 20, 1, ui_panel_x);

        // Initialize stars
        initStars();

        // Start benchmark threads
        startThreads();
    }

    void initStars()
    {
        stars.clear();
        for (int i = 0; i < 50; i++)
        {
            Star star;
            star.pos.x = rng() % game_area_width;
            star.pos.y = rng() % game_area_height;
            star.speed = 0.5f + (rng() % 100) / 100.0f;
            star.symbol = (rng() % 3 == 0) ? '*' : '.';
            star.brightness = (star.symbol == '*') ? 1 : 0;
            stars.push_back(star);
        }
    }

    void startThreads()
    {
        // Start clock_gettime threads (4 threads)
        for (int i = 0; i < 4; i++)
        {
            clock_threads.emplace_back([this, i]()
                                       {
                struct timespec ts;
                while (g_game_running.load()) {
                    if (!g_game_paused.load()) {
                        // Call clock_gettime frequently
                        for (int j = 0; j < 100; j++) {
                            clock_gettime(CLOCK_MONOTONIC, &ts);
                            clock_call_count++;
                        }
                    }
                    std::this_thread::sleep_for(std::chrono::microseconds(500));
                } });
        }

        // Start memory access threads (3 threads)
        for (int i = 0; i < 3; i++)
        {
            memory_threads.emplace_back([this, i]()
                                        {
                volatile int32_t local_hp, local_score, local_combo;
                while (g_game_running.load()) {
                    if (!g_game_paused.load()) {
                        // Read game state frequently
                        for (int j = 0; j < 50; j++) {
                            local_hp = g_player_hp;
                            local_score = g_score;
                            local_combo = g_combo_count;
                            memory_read_count++;
                            
                            // Small delay to prevent tight spin
                            std::this_thread::yield();
                        }
                    }
                    std::this_thread::sleep_for(std::chrono::microseconds(200));
                } });
        }
    }

    void stopThreads()
    {
        g_game_running.store(false);

        for (auto &t : clock_threads)
        {
            if (t.joinable())
                t.join();
        }
        for (auto &t : memory_threads)
        {
            if (t.joinable())
                t.join();
        }
    }

    void resetGame()
    {
        std::lock_guard<std::mutex> lock(g_state_mutex);

        // Reset player
        player.pos = Vec2(5, game_area_height / 2);
        player.shield = 0;
        player.weapon_level = 1;
        player.invincible = false;
        player.invincible_timer = 0;

        // Reset game state
        if (g_score > g_high_score)
        {
            g_high_score = g_score;
        }
        g_score = 0;
        g_player_hp = 100;
        g_max_hp = 100;
        g_level = 1;
        g_enemies_killed = 0;
        g_bullets_fired = 0;
        g_combo_count = 0;
        g_play_time_ms = 0;

        g_game_over.store(false);
        g_game_paused.store(false);

        // Clear entities
        for (auto &b : bullets)
            b.active = false;
        for (auto &e : enemies)
            e.active = false;
        for (auto &eb : enemy_bullets)
            eb.active = false;
        for (auto &ex : explosions)
            ex.active = false;
        for (auto &p : powerups)
            p.active = false;

        frame_count = 0;
        enemy_spawn_timer = 0;
        difficulty_timer = 0;
    }

    void showTitleScreen()
    {
        clear();

        int center_x = screen_width / 2;
        int y = 3;

        // Simple ASCII title
        attron(COLOR_PAIR(COLOR_PAIR_TITLE) | A_BOLD);
        mvprintw(y++, center_x - 20, "========================================");
        mvprintw(y++, center_x - 20, "        STELLAR DEFENDER v2.0           ");
        mvprintw(y++, center_x - 20, "    -- Horizontal Scrolling Shooter --  ");
        mvprintw(y++, center_x - 20, "========================================");
        attroff(COLOR_PAIR(COLOR_PAIR_TITLE) | A_BOLD);

        y += 2;

        // Menu
        attron(COLOR_PAIR(COLOR_PAIR_UI_NORMAL) | A_BOLD);
        mvprintw(y++, center_x - 12, "+----------------------+");
        mvprintw(y++, center_x - 12, "|   [ENTER] START      |");
        mvprintw(y++, center_x - 12, "|   [M] MEMORY INFO    |");
        mvprintw(y++, center_x - 12, "|   [Q] QUIT           |");
        mvprintw(y++, center_x - 12, "+----------------------+");
        attroff(COLOR_PAIR(COLOR_PAIR_UI_NORMAL) | A_BOLD);

        y += 2;

        // Controls
        attron(COLOR_PAIR(COLOR_PAIR_UI_WARNING));
        mvprintw(y++, center_x - 20, "CONTROLS: [W/S] Move  [SPACE] Fire  [P] Pause");
        attroff(COLOR_PAIR(COLOR_PAIR_UI_WARNING));

        y += 2;

        // Debug addresses
        attron(COLOR_PAIR(COLOR_PAIR_DEBUG_INFO));
        mvprintw(y++, center_x - 22, "--- DEBUG MEMORY ADDRESSES ---");
        mvprintw(y++, center_x - 22, "g_score:     %p = %d", (void *)&g_score, (int)g_score);
        mvprintw(y++, center_x - 22, "g_player_hp: %p = %d", (void *)&g_player_hp, (int)g_player_hp);
        attroff(COLOR_PAIR(COLOR_PAIR_DEBUG_INFO));

        // High score
        if (g_high_score > 0)
        {
            attron(COLOR_PAIR(COLOR_PAIR_UI_HIGHLIGHT) | A_BOLD);
            mvprintw(screen_height - 2, center_x - 10, "HIGH SCORE: %d", (int)g_high_score);
            attroff(COLOR_PAIR(COLOR_PAIR_UI_HIGHLIGHT) | A_BOLD);
        }

        refresh();
    }

    void showMemoryInfo()
    {
        clear();

        int y = 2;
        int x = 5;

        attron(COLOR_PAIR(COLOR_PAIR_TITLE) | A_BOLD);
        mvprintw(y++, x, "+------------------------------------------------------------------+");
        mvprintw(y++, x, "|              MEMORY DEBUGGING INFORMATION                        |");
        mvprintw(y++, x, "+------------------------------------------------------------------+");
        attroff(COLOR_PAIR(COLOR_PAIR_TITLE) | A_BOLD);

        y += 2;

        attron(COLOR_PAIR(COLOR_PAIR_DEBUG_INFO));
        mvprintw(y++, x, "Global variables exposed for debugging:");
        y++;

        mvprintw(y++, x, "+---------------------+--------------------+-----------------+");
        mvprintw(y++, x, "| Variable            | Address            | Current Value   |");
        mvprintw(y++, x, "+---------------------+--------------------+-----------------+");
        mvprintw(y++, x, "| g_score             | %18p | %15d |", (void *)&g_score, (int)g_score);
        mvprintw(y++, x, "| g_player_hp         | %18p | %15d |", (void *)&g_player_hp, (int)g_player_hp);
        mvprintw(y++, x, "| g_max_hp            | %18p | %15d |", (void *)&g_max_hp, (int)g_max_hp);
        mvprintw(y++, x, "| g_level             | %18p | %15d |", (void *)&g_level, (int)g_level);
        mvprintw(y++, x, "| g_enemies_killed    | %18p | %15d |", (void *)&g_enemies_killed, (int)g_enemies_killed);
        mvprintw(y++, x, "| g_bullets_fired     | %18p | %15d |", (void *)&g_bullets_fired, (int)g_bullets_fired);
        mvprintw(y++, x, "| g_combo_count       | %18p | %15d |", (void *)&g_combo_count, (int)g_combo_count);
        mvprintw(y++, x, "| g_high_score        | %18p | %15d |", (void *)&g_high_score, (int)g_high_score);
        mvprintw(y++, x, "| g_play_time_ms      | %18p | %15ld |", (void *)&g_play_time_ms, (long)g_play_time_ms);
        mvprintw(y++, x, "+---------------------+--------------------+-----------------+");

        y += 2;

        mvprintw(y++, x, "Benchmark Thread Status:");
        mvprintw(y++, x, "  - Clock threads: 4 (calling clock_gettime at high frequency)");
        mvprintw(y++, x, "  - Memory threads: 3 (reading HP/Score at high frequency)");
        mvprintw(y++, x, "  - Clock calls: %ld", clock_call_count.load());
        mvprintw(y++, x, "  - Memory reads: %ld", memory_read_count.load());

        attroff(COLOR_PAIR(COLOR_PAIR_DEBUG_INFO));

        y += 2;
        attron(COLOR_PAIR(COLOR_PAIR_UI_WARNING));
        mvprintw(y, x, "Press any key to return...");
        attroff(COLOR_PAIR(COLOR_PAIR_UI_WARNING));

        refresh();

        nodelay(stdscr, FALSE);
        getch();
        nodelay(stdscr, TRUE);
    }

    void spawnEnemy()
    {
        for (auto &e : enemies)
        {
            if (!e.active)
            {
                e.active = true;
                e.pos.x = game_area_width - 1;
                e.pos.y = 1 + (rng() % (game_area_height - 2));
                e.base_y = e.pos.y;

                // Determine enemy type based on level and random
                int type_roll = rng() % 100;
                int level = g_level;

                if (type_roll < 10 && level >= 5)
                {
                    // Boss (10% chance, level 5+)
                    e.type = 3;
                    e.hp = 100 + level * 20;
                    e.max_hp = e.hp;
                    e.score_value = 1000;
                    e.velocity = Vec2(-0.3f, 0);
                    e.sprite = "<[XXX]>";
                    e.color = COLOR_PAIR_ENEMY_BOSS;
                    e.amplitude = 3.0f;
                }
                else if (type_roll < 30 && level >= 3)
                {
                    // Strong (20% chance, level 3+)
                    e.type = 2;
                    e.hp = 30 + level * 5;
                    e.max_hp = e.hp;
                    e.score_value = 300;
                    e.velocity = Vec2(-0.6f, 0);
                    e.sprite = "<##>";
                    e.color = COLOR_PAIR_ENEMY_STRONG;
                    e.amplitude = 2.0f;
                }
                else if (type_roll < 60)
                {
                    // Normal (30% chance)
                    e.type = 1;
                    e.hp = 15 + level * 2;
                    e.max_hp = e.hp;
                    e.score_value = 150;
                    e.velocity = Vec2(-0.8f, 0);
                    e.sprite = "<#>";
                    e.color = COLOR_PAIR_ENEMY_NORMAL;
                    e.amplitude = 1.5f;
                }
                else
                {
                    // Weak (40% chance)
                    e.type = 0;
                    e.hp = 5 + level;
                    e.max_hp = e.hp;
                    e.score_value = 50;
                    e.velocity = Vec2(-1.0f, 0);
                    e.sprite = "<>";
                    e.color = COLOR_PAIR_ENEMY_WEAK;
                    e.amplitude = 1.0f;
                }

                e.phase = (rng() % 628) / 100.0f; // Random phase 0-2π
                e.fire_cooldown = 30 + rng() % 60;

                break;
            }
        }
    }

    void fireBullet()
    {
        for (auto &b : bullets)
        {
            if (!b.active)
            {
                b.active = true;
                b.pos = Vec2(player.pos.x + 5, player.pos.y + 1);
                b.velocity = Vec2(2.0f, 0);
                b.damage = 10 + player.weapon_level * 5;
                b.symbol = (player.weapon_level >= 3) ? '=' : '-';
                g_bullets_fired++;
                break;
            }
        }

        // Additional bullets for higher weapon levels
        if (player.weapon_level >= 2)
        {
            for (auto &b : bullets)
            {
                if (!b.active)
                {
                    b.active = true;
                    b.pos = Vec2(player.pos.x + 4, player.pos.y);
                    b.velocity = Vec2(2.0f, -0.3f);
                    b.damage = 8;
                    break;
                }
            }
            for (auto &b : bullets)
            {
                if (!b.active)
                {
                    b.active = true;
                    b.pos = Vec2(player.pos.x + 4, player.pos.y + 2);
                    b.velocity = Vec2(2.0f, 0.3f);
                    b.damage = 8;
                    break;
                }
            }
        }
    }

    void fireEnemyBullet(Enemy &enemy)
    {
        for (auto &eb : enemy_bullets)
        {
            if (!eb.active)
            {
                eb.active = true;
                eb.pos = Vec2(enemy.pos.x - 1, enemy.pos.y);
                eb.velocity = Vec2(-1.5f, 0);
                eb.damage = 5 + g_level;
                eb.symbol = (enemy.type >= 2) ? 'o' : '*';
                break;
            }
        }
    }

    void spawnExplosion(float x, float y)
    {
        for (auto &ex : explosions)
        {
            if (!ex.active)
            {
                ex.active = true;
                ex.pos = Vec2(x, y);
                ex.frame = 0;
                break;
            }
        }
    }

    void spawnPowerup(float x, float y)
    {
        if (rng() % 100 < 15)
        { // 15% chance
            for (auto &p : powerups)
            {
                if (!p.active)
                {
                    p.active = true;
                    p.pos = Vec2(x, y);
                    p.velocity = Vec2(-0.5f, 0);
                    p.type = rng() % 3;
                    switch (p.type)
                    {
                    case 0:
                        p.symbol = '+';
                        break; // Heal
                    case 1:
                        p.symbol = 'S';
                        break; // Shield
                    case 2:
                        p.symbol = 'W';
                        break; // Weapon
                    }
                    break;
                }
            }
        }
    }

    void update()
    {
        if (g_game_paused.load() || g_game_over.load())
            return;

        std::lock_guard<std::mutex> lock(g_state_mutex);

        frame_count++;
        g_play_time_ms += 33; // Approximately 30 FPS

        // Update difficulty
        difficulty_timer++;
        if (difficulty_timer >= 600)
        { // Every ~20 seconds
            difficulty_timer = 0;
            g_level++;
        }

        // Spawn enemies
        enemy_spawn_timer++;
        int spawn_rate = std::max(30, 90 - g_level * 5);
        if (enemy_spawn_timer >= spawn_rate)
        {
            enemy_spawn_timer = 0;
            spawnEnemy();
        }

        // Update player
        if (player.fire_cooldown > 0)
            player.fire_cooldown--;
        if (player.invincible)
        {
            player.invincible_timer--;
            if (player.invincible_timer <= 0)
            {
                player.invincible = false;
            }
        }

        // Update stars (parallax background)
        for (auto &star : stars)
        {
            star.pos.x -= star.speed;
            if (star.pos.x < 0)
            {
                star.pos.x = game_area_width - 1;
                star.pos.y = rng() % game_area_height;
            }
        }

        // Update bullets
        for (auto &b : bullets)
        {
            if (b.active)
            {
                b.pos.x += b.velocity.x;
                b.pos.y += b.velocity.y;

                if (b.pos.x >= game_area_width || b.pos.x < 0 ||
                    b.pos.y < 0 || b.pos.y >= game_area_height)
                {
                    b.active = false;
                }
            }
        }

        // Update enemies
        for (auto &e : enemies)
        {
            if (e.active)
            {
                e.pos.x += e.velocity.x;
                e.phase += 0.1f;
                e.pos.y = e.base_y + std::sin(e.phase) * e.amplitude;

                // Clamp to bounds
                e.pos.y = std::max(1.0f, std::min<float>((float)(game_area_height - 2), e.pos.y));

                // Fire bullets
                e.fire_cooldown--;
                if (e.fire_cooldown <= 0 && e.type >= 1)
                {
                    e.fire_cooldown = 60 + rng() % 60 - g_level * 2;
                    fireEnemyBullet(e);
                }

                // Off-screen
                if (e.pos.x < -5)
                {
                    e.active = false;
                    g_combo_count = 0; // Reset combo
                }
            }
        }

        // Update enemy bullets
        for (auto &eb : enemy_bullets)
        {
            if (eb.active)
            {
                eb.pos.x += eb.velocity.x;
                eb.pos.y += eb.velocity.y;

                if (eb.pos.x < 0 || eb.pos.x >= game_area_width ||
                    eb.pos.y < 0 || eb.pos.y >= game_area_height)
                {
                    eb.active = false;
                }
            }
        }

        // Update explosions
        for (auto &ex : explosions)
        {
            if (ex.active)
            {
                ex.frame++;
                if (ex.frame >= ex.max_frames)
                {
                    ex.active = false;
                }
            }
        }

        // Update powerups
        for (auto &p : powerups)
        {
            if (p.active)
            {
                p.pos.x += p.velocity.x;
                if (p.pos.x < 0)
                {
                    p.active = false;
                }
            }
        }

        // Check collisions
        checkCollisions();

        // Check game over
        if (g_player_hp <= 0)
        {
            g_game_over.store(true);
            if (g_score > g_high_score)
            {
                g_high_score = g_score;
            }
        }
    }

    void checkCollisions()
    {
        // Bullets vs Enemies
        for (auto &b : bullets)
        {
            if (!b.active)
                continue;

            for (auto &e : enemies)
            {
                if (!e.active)
                    continue;

                // Simple box collision
                if (b.pos.x >= e.pos.x - 1 && b.pos.x <= e.pos.x + (int)e.sprite.length() &&
                    b.pos.y >= e.pos.y - 0.5f && b.pos.y <= e.pos.y + 0.5f)
                {

                    b.active = false;
                    e.hp -= b.damage;

                    if (e.hp <= 0)
                    {
                        e.active = false;
                        g_enemies_killed++;
                        g_combo_count++;

                        // Score with combo multiplier
                        int combo_mult = std::min<int32_t>(10, (int)g_combo_count);
                        g_score += e.score_value * combo_mult;

                        spawnExplosion(e.pos.x, e.pos.y);
                        spawnPowerup(e.pos.x, e.pos.y);
                    }

                    break;
                }
            }
        }

        // Enemy bullets vs Player
        if (!player.invincible)
        {
            for (auto &eb : enemy_bullets)
            {
                if (!eb.active)
                    continue;

                if (eb.pos.x >= player.pos.x && eb.pos.x <= player.pos.x + 5 &&
                    eb.pos.y >= player.pos.y && eb.pos.y <= player.pos.y + 3)
                {

                    eb.active = false;

                    if (player.shield > 0)
                    {
                        player.shield -= eb.damage;
                        if (player.shield < 0)
                            player.shield = 0;
                    }
                    else
                    {
                        g_player_hp -= eb.damage;
                        player.invincible = true;
                        player.invincible_timer = 30;
                        g_combo_count = 0;
                    }
                }
            }
        }

        // Enemies vs Player (collision damage)
        if (!player.invincible)
        {
            for (auto &e : enemies)
            {
                if (!e.active)
                    continue;

                if (e.pos.x >= player.pos.x - 1 && e.pos.x <= player.pos.x + 5 &&
                    e.pos.y >= player.pos.y - 1 && e.pos.y <= player.pos.y + 3)
                {

                    e.active = false;
                    g_player_hp -= 20;
                    player.invincible = true;
                    player.invincible_timer = 60;
                    g_combo_count = 0;
                    spawnExplosion(e.pos.x, e.pos.y);
                }
            }
        }

        // Powerups vs Player
        for (auto &p : powerups)
        {
            if (!p.active)
                continue;

            if (p.pos.x >= player.pos.x && p.pos.x <= player.pos.x + 5 &&
                p.pos.y >= player.pos.y && p.pos.y <= player.pos.y + 3)
            {

                p.active = false;

                switch (p.type)
                {
                case 0: // Heal
                    g_player_hp = std::min((int)g_max_hp, g_player_hp + 30);
                    break;
                case 1: // Shield
                    player.shield = std::min(50, player.shield + 25);
                    break;
                case 2: // Weapon
                    player.weapon_level = std::min(3, player.weapon_level + 1);
                    break;
                }
            }
        }
    }

    void handleInput()
    {
        int ch = getch();
        if (ch == ERR)
            return;

        if (g_show_title.load())
        {
            switch (ch)
            {
            case '\n':
            case '\r':
            case KEY_ENTER:
                g_show_title.store(false);
                resetGame();
                break;
            case 'm':
            case 'M':
                showMemoryInfo();
                break;
            case 'q':
            case 'Q':
                g_game_running.store(false);
                break;
            }
            return;
        }

        if (g_game_over.load())
        {
            switch (ch)
            {
            case 'r':
            case 'R':
                resetGame();
                break;
            case 'q':
            case 'Q':
            case '\n':
            case '\r':
                g_show_title.store(true);
                break;
            }
            return;
        }

        switch (ch)
        {
        case 'w':
        case 'W':
        case KEY_UP:
            if (!g_game_paused.load())
            {
                std::lock_guard<std::mutex> lock(g_state_mutex);
                player.pos.y = std::max(0.0f, player.pos.y - 1);
            }
            break;

        case 's':
        case 'S':
        case KEY_DOWN:
            if (!g_game_paused.load())
            {
                std::lock_guard<std::mutex> lock(g_state_mutex);
                player.pos.y = std::min((float)(game_area_height - 3), player.pos.y + 1);
            }
            break;

        case ' ':
            if (!g_game_paused.load() && player.fire_cooldown <= 0)
            {
                std::lock_guard<std::mutex> lock(g_state_mutex);
                fireBullet();
                player.fire_cooldown = 5;
            }
            break;

        case 'p':
        case 'P':
            g_game_paused.store(!g_game_paused.load());
            break;

        case 'r':
        case 'R':
            resetGame();
            break;

        case 'q':
        case 'Q':
            g_show_title.store(true);
            break;

        case 'm':
        case 'M':
            showMemoryInfo();
            break;
        }
    }

    void render()
    {
        std::lock_guard<std::mutex> lock(g_render_mutex);

        // Clear windows
        werase(game_win);
        werase(ui_win);

        // Draw game area border
        wattron(game_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));
        box(game_win, 0, 0);
        wattroff(game_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));

        // Draw stars (background)
        for (const auto &star : stars)
        {
            int x = (int)star.pos.x + 1;
            int y = (int)star.pos.y + 1;
            if (x > 0 && x < game_area_width + 1 && y > 0 && y < game_area_height + 1)
            {
                wattron(game_win, COLOR_PAIR(star.brightness ? COLOR_PAIR_STAR_BRIGHT : COLOR_PAIR_STAR_DIM));
                mvwaddch(game_win, y, x, star.symbol);
                wattroff(game_win, COLOR_PAIR(star.brightness ? COLOR_PAIR_STAR_BRIGHT : COLOR_PAIR_STAR_DIM));
            }
        }

        // Draw explosions
        for (const auto &ex : explosions)
        {
            if (ex.active)
            {
                int x = (int)ex.pos.x + 1;
                int y = (int)ex.pos.y + 1;
                if (x > 0 && x < game_area_width + 1 && y > 0 && y < game_area_height + 1)
                {
                    wattron(game_win, COLOR_PAIR(COLOR_PAIR_EXPLOSION) | A_BOLD);
                    const char *frames[] = {"*", "+", "X", "#", "*", ".", " ", " "};
                    mvwaddch(game_win, y, x, frames[ex.frame][0]);
                    wattroff(game_win, COLOR_PAIR(COLOR_PAIR_EXPLOSION) | A_BOLD);
                }
            }
        }

        // Draw powerups
        for (const auto &p : powerups)
        {
            if (p.active)
            {
                int x = (int)p.pos.x + 1;
                int y = (int)p.pos.y + 1;
                if (x > 0 && x < game_area_width + 1 && y > 0 && y < game_area_height + 1)
                {
                    wattron(game_win, COLOR_PAIR(COLOR_PAIR_POWERUP) | A_BOLD | A_BLINK);
                    mvwaddch(game_win, y, x, p.symbol);
                    wattroff(game_win, COLOR_PAIR(COLOR_PAIR_POWERUP) | A_BOLD | A_BLINK);
                }
            }
        }

        // Draw bullets
        for (const auto &b : bullets)
        {
            if (b.active)
            {
                int x = (int)b.pos.x + 1;
                int y = (int)b.pos.y + 1;
                if (x > 0 && x < game_area_width + 1 && y > 0 && y < game_area_height + 1)
                {
                    wattron(game_win, COLOR_PAIR(COLOR_PAIR_BULLET) | A_BOLD);
                    mvwaddch(game_win, y, x, b.symbol);
                    wattroff(game_win, COLOR_PAIR(COLOR_PAIR_BULLET) | A_BOLD);
                }
            }
        }

        // Draw enemy bullets
        for (const auto &eb : enemy_bullets)
        {
            if (eb.active)
            {
                int x = (int)eb.pos.x + 1;
                int y = (int)eb.pos.y + 1;
                if (x > 0 && x < game_area_width + 1 && y > 0 && y < game_area_height + 1)
                {
                    wattron(game_win, COLOR_PAIR(COLOR_PAIR_ENEMY_STRONG));
                    mvwaddch(game_win, y, x, eb.symbol);
                    wattroff(game_win, COLOR_PAIR(COLOR_PAIR_ENEMY_STRONG));
                }
            }
        }

        // Draw enemies
        for (const auto &e : enemies)
        {
            if (e.active)
            {
                int x = (int)e.pos.x + 1;
                int y = (int)e.pos.y + 1;
                if (y > 0 && y < game_area_height + 1)
                {
                    wattron(game_win, COLOR_PAIR(e.color) | A_BOLD);
                    for (size_t i = 0; i < e.sprite.length(); i++)
                    {
                        int sx = x - (int)i;
                        if (sx > 0 && sx < game_area_width + 1)
                        {
                            mvwaddch(game_win, y, sx, e.sprite[e.sprite.length() - 1 - i]);
                        }
                    }
                    wattroff(game_win, COLOR_PAIR(e.color) | A_BOLD);

                    // Draw HP bar for strong enemies
                    if (e.type >= 2 && e.hp < e.max_hp)
                    {
                        int bar_x = x - (int)e.sprite.length() / 2;
                        if (bar_x > 0 && bar_x < game_area_width - 2 && y > 1)
                        {
                            float hp_ratio = (float)e.hp / e.max_hp;
                            wattron(game_win, COLOR_PAIR(hp_ratio > 0.5 ? COLOR_PAIR_ENEMY_WEAK : COLOR_PAIR_ENEMY_STRONG));
                            mvwaddch(game_win, y - 1, bar_x, '[');
                            int filled = (int)(hp_ratio * 4);
                            for (int i = 0; i < 4; i++)
                            {
                                mvwaddch(game_win, y - 1, bar_x + 1 + i, i < filled ? '=' : ' ');
                            }
                            mvwaddch(game_win, y - 1, bar_x + 5, ']');
                            wattroff(game_win, COLOR_PAIR(hp_ratio > 0.5 ? COLOR_PAIR_ENEMY_WEAK : COLOR_PAIR_ENEMY_STRONG));
                        }
                    }
                }
            }
        }

        // Draw player
        int px = (int)player.pos.x + 1;
        int py = (int)player.pos.y + 1;

        // Blinking effect when invincible
        bool draw_player = !player.invincible || (frame_count % 4 < 2);

        if (draw_player)
        {
            int player_color = player.shield > 0 ? COLOR_PAIR_PLAYER_SHIELD : COLOR_PAIR_PLAYER;
            wattron(game_win, COLOR_PAIR(player_color) | A_BOLD);

            for (int i = 0; i < 3; i++)
            {
                if (py + i > 0 && py + i < game_area_height + 1)
                {
                    for (int j = 0; j < 5; j++)
                    {
                        if (px + j > 0 && px + j < game_area_width + 1)
                        {
                            char c = player.sprite[i][j];
                            if (c != ' ')
                            {
                                mvwaddch(game_win, py + i, px + j, c);
                            }
                        }
                    }
                }
            }

            wattroff(game_win, COLOR_PAIR(player_color) | A_BOLD);
        }

        // Draw UI panel
        wattron(ui_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));
        box(ui_win, 0, 0);
        mvwprintw(ui_win, 0, 2, " STATUS ");
        wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));

        int ui_y = 2;

        // Score
        wattron(ui_win, COLOR_PAIR(COLOR_PAIR_UI_HIGHLIGHT) | A_BOLD);
        mvwprintw(ui_win, ui_y++, 2, "SCORE");
        wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_UI_HIGHLIGHT) | A_BOLD);
        wattron(ui_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));
        mvwprintw(ui_win, ui_y++, 2, "%10d", (int)g_score);
        wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));

        ui_y++;

        // HP with color based on value
        wattron(ui_win, COLOR_PAIR(COLOR_PAIR_UI_HIGHLIGHT) | A_BOLD);
        mvwprintw(ui_win, ui_y++, 2, "HP");
        wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_UI_HIGHLIGHT) | A_BOLD);

        float hp_ratio = (float)g_player_hp / g_max_hp;
        int hp_color = hp_ratio > 0.6 ? COLOR_PAIR_UI_NORMAL : (hp_ratio > 0.3 ? COLOR_PAIR_UI_WARNING : COLOR_PAIR_UI_DANGER);

        wattron(ui_win, COLOR_PAIR(hp_color) | A_BOLD);
        mvwprintw(ui_win, ui_y++, 2, "%3d / %3d", (int)g_player_hp, (int)g_max_hp);

        // HP Bar
        mvwaddch(ui_win, ui_y, 2, '[');
        int hp_bar_len = 12;
        int hp_filled = (int)(hp_ratio * hp_bar_len);
        for (int i = 0; i < hp_bar_len; i++)
        {
            mvwaddch(ui_win, ui_y, 3 + i, i < hp_filled ? '=' : ' ');
        }
        mvwaddch(ui_win, ui_y++, 3 + hp_bar_len, ']');
        wattroff(ui_win, COLOR_PAIR(hp_color) | A_BOLD);

        ui_y++;

        // Shield
        if (player.shield > 0)
        {
            wattron(ui_win, COLOR_PAIR(COLOR_PAIR_PLAYER_SHIELD) | A_BOLD);
            mvwprintw(ui_win, ui_y++, 2, "SHIELD: %d", player.shield);
            wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_PLAYER_SHIELD) | A_BOLD);
            ui_y++;
        }

        // Level
        wattron(ui_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));
        mvwprintw(ui_win, ui_y++, 2, "LEVEL: %d", (int)g_level);

        // Combo
        if (g_combo_count > 1)
        {
            wattron(ui_win, COLOR_PAIR(COLOR_PAIR_UI_WARNING) | A_BOLD);
            mvwprintw(ui_win, ui_y++, 2, "COMBO x%d", (int)g_combo_count);
            wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_UI_WARNING) | A_BOLD);
        }
        else
        {
            ui_y++;
        }

        // Kills
        mvwprintw(ui_win, ui_y++, 2, "KILLS: %d", (int)g_enemies_killed);

        // Weapon level
        mvwprintw(ui_win, ui_y++, 2, "WEAPON: Lv%d", player.weapon_level);
        wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_UI_NORMAL));

        ui_y++;

        // Memory addresses (debug info)
        wattron(ui_win, COLOR_PAIR(COLOR_PAIR_DEBUG_INFO));
        mvwprintw(ui_win, ui_y++, 1, "-- DEBUG --");
        mvwprintw(ui_win, ui_y++, 1, "Score:");
        mvwprintw(ui_win, ui_y++, 1, "%p", (void *)&g_score);
        mvwprintw(ui_win, ui_y++, 1, "HP:");
        mvwprintw(ui_win, ui_y++, 1, "%p", (void *)&g_player_hp);
        wattroff(ui_win, COLOR_PAIR(COLOR_PAIR_DEBUG_INFO));

        // Paused overlay
        if (g_game_paused.load())
        {
            wattron(game_win, COLOR_PAIR(COLOR_PAIR_UI_WARNING) | A_BOLD | A_REVERSE);
            mvwprintw(game_win, game_area_height / 2, game_area_width / 2 - 5, "  PAUSED  ");
            mvwprintw(game_win, game_area_height / 2 + 1, game_area_width / 2 - 8, " [P] to Resume ");
            wattroff(game_win, COLOR_PAIR(COLOR_PAIR_UI_WARNING) | A_BOLD | A_REVERSE);
        }

        // Game over overlay
        if (g_game_over.load())
        {
            wattron(game_win, COLOR_PAIR(COLOR_PAIR_UI_DANGER) | A_BOLD | A_REVERSE);
            mvwprintw(game_win, game_area_height / 2 - 1, game_area_width / 2 - 6, "  GAME OVER  ");
            mvwprintw(game_win, game_area_height / 2, game_area_width / 2 - 10, " Final Score: %6d ", (int)g_score);
            mvwprintw(game_win, game_area_height / 2 + 1, game_area_width / 2 - 8, " [R]estart [Q]uit ");
            wattroff(game_win, COLOR_PAIR(COLOR_PAIR_UI_DANGER) | A_BOLD | A_REVERSE);
        }

        // Refresh windows (double-buffered)
        wnoutrefresh(game_win);
        wnoutrefresh(ui_win);
        doupdate();
    }

    void run()
    {
        init();

        auto last_time = std::chrono::steady_clock::now();
        const auto frame_duration = std::chrono::milliseconds(33); // ~30 FPS

        while (g_game_running.load())
        {
            handleInput();

            if (g_show_title.load())
            {
                showTitleScreen();
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }

            update();
            render();

            // Frame timing
            auto current_time = std::chrono::steady_clock::now();
            auto elapsed = current_time - last_time;
            if (elapsed < frame_duration)
            {
                std::this_thread::sleep_for(frame_duration - elapsed);
            }
            last_time = std::chrono::steady_clock::now();
        }

        // Cleanup
        stopThreads();
        endwin();
    }
};

// ============================================================================
// MAIN
// ============================================================================

int main()
{
    // Print memory addresses before starting ncurses
    printf("\n");
    printf("+-------------------------------------------------------------------+\n");
    printf("|               STELLAR DEFENDER - Debug Information                |\n");
    printf("+-------------------------------------------------------------------+\n");
    printf("|  Variable           | Memory Address       | Initial Value       |\n");
    printf("+-------------------------------------------------------------------+\n");
    printf("|  g_score            | %-20p | %-19d |\n", (void *)&g_score, (int)g_score);
    printf("|  g_player_hp        | %-20p | %-19d |\n", (void *)&g_player_hp, (int)g_player_hp);
    printf("|  g_max_hp           | %-20p | %-19d |\n", (void *)&g_max_hp, (int)g_max_hp);
    printf("|  g_level            | %-20p | %-19d |\n", (void *)&g_level, (int)g_level);
    printf("|  g_enemies_killed   | %-20p | %-19d |\n", (void *)&g_enemies_killed, (int)g_enemies_killed);
    printf("|  g_bullets_fired    | %-20p | %-19d |\n", (void *)&g_bullets_fired, (int)g_bullets_fired);
    printf("|  g_combo_count      | %-20p | %-19d |\n", (void *)&g_combo_count, (int)g_combo_count);
    printf("|  g_high_score       | %-20p | %-19d |\n", (void *)&g_high_score, (int)g_high_score);
    printf("|  g_play_time_ms     | %-20p | %-19ld |\n", (void *)&g_play_time_ms, (long)g_play_time_ms);
    printf("+-------------------------------------------------------------------+\n");
    printf("\n");
    printf("Starting game... Press ENTER to continue.\n");
    getchar();

    StellarDefender game;
    game.run();

    return 0;
}
