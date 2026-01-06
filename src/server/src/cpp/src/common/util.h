#ifndef UTIL_H
#define UTIL_H

#include <cstdint>
#include <iomanip>
#include <map>
#include <sstream>
#include <string>
#include <vector>

std::string map_vector_to_json_string(
    const std::vector<std::map<std::string, uint64_t>>& map_vector);
#endif