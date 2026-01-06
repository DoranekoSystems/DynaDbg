#include "util.h"

std::string map_vector_to_json_string(
    const std::vector<std::map<std::string, uint64_t>>& map_vector)
{
    std::ostringstream json;
    json << "{";

    bool first = true;
    for (size_t i = 0; i < map_vector.size(); ++i)
    {
        const auto& map = map_vector[i];
        for (const auto& [key, value] : map)
        {
            if (!first)
            {
                json << ",";
            }
            first = false;

            // Special handling for exception_type - convert to number instead of hex string
            if (key == "exception_type")
            {
                json << "\"" << key << "\":" << std::dec << value;
            }
            // Special handling for thread_id - convert to number instead of hex string
            else if (key == "thread_id")
            {
                json << "\"" << key << "\":" << std::dec << value;
            }
            // Special handling for memory - convert to number instead of hex string
            else if (key == "memory")
            {
                json << "\"" << key << "\":" << std::dec << value;
            }
            // All other values (registers) as hex strings
            else
            {
                json << "\"" << key << "\":\"0x" << std::hex << std::uppercase << std::setw(16)
                     << std::setfill('0') << value << "\"";
            }
        }
    }

    json << "}";
    return json.str();
}