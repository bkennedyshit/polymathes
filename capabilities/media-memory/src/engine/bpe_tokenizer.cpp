#include "omni/search/bpe_tokenizer.hpp"

#include <spdlog/spdlog.h>
#include <nlohmann/json.hpp>

#include <fstream>
#include <sstream>
#include <regex>
#include <algorithm>
#include <cctype>

namespace omni {
namespace search {

namespace {

// Regex pattern for CLIP tokenization (handles contractions, punctuation, etc.)
const char* CLIP_PATTERN = R"('s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+)";

// Helper function to convert a byte to its unicode representation
std::string byte_to_unicode_char(unsigned char byte) {
    // CLIP uses a specific byte-to-unicode mapping
    static const std::vector<unsigned char> byte_values = []() {
        std::vector<unsigned char> values;
        
        // Characters 33-126 and 161-172 and 174-255 map directly
        for (int b = static_cast<int>('!'); b <= static_cast<int>('~'); ++b) {
            values.push_back(static_cast<unsigned char>(b));
        }
        for (int b = 161; b <= 172; ++b) {
            values.push_back(static_cast<unsigned char>(b));
        }
        for (int b = 174; b <= 255; ++b) {
            values.push_back(static_cast<unsigned char>(b));
        }
        
        // Other bytes are offset to avoid conflicts
        int offset = 256;
        for (int b = 0; b < 256; ++b) {
            if (std::find(values.begin(), values.end(), static_cast<unsigned char>(b)) == values.end()) {
                values.push_back(static_cast<unsigned char>(offset++));
            }
        }
        
        return values;
    }();
    
    if (byte < byte_values.size()) {
        return std::string(1, static_cast<char>(byte_values[byte]));
    }
    
    return std::string(1, static_cast<char>(byte));
}

} // anonymous namespace

const char* BPETokenizer::get_pattern() {
    return CLIP_PATTERN;
}

BPETokenizer::BPETokenizer(const std::string& model_dir) {
    spdlog::info("Initializing BPE tokenizer from: {}", model_dir);
    
    // Initialize byte encoder
    init_byte_encoder();
    
    // Load vocabulary
    std::string vocab_path = model_dir + "/tokenizer/vocab.json";
    load_vocab(vocab_path);
    
    // Load merges
    std::string merges_path = model_dir + "/tokenizer/merges.txt";
    load_merges(merges_path);
    
    spdlog::info("BPE tokenizer initialized with {} vocab entries and {} merges",
                 vocab_.size(), bpe_ranks_.size());
}

void BPETokenizer::init_byte_encoder() {
    // Build the byte encoder/decoder maps
    for (int i = 0; i < 256; ++i) {
        unsigned char byte = static_cast<unsigned char>(i);
        std::string unicode_char = byte_to_unicode_char(byte);
        byte_encoder_[byte] = unicode_char;
        byte_decoder_[unicode_char] = byte;
    }
}

void BPETokenizer::load_vocab(const std::string& vocab_path) {
    std::ifstream file(vocab_path);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open vocab file: " + vocab_path);
    }
    
    nlohmann::json vocab_json;
    file >> vocab_json;
    
    // vocab.json is a map of token string -> token ID
    for (auto& [token, id] : vocab_json.items()) {
        vocab_[token] = id.get<int32_t>();
    }
    
    spdlog::debug("Loaded {} vocabulary entries", vocab_.size());
}

void BPETokenizer::load_merges(const std::string& merges_path) {
    std::ifstream file(merges_path);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open merges file: " + merges_path);
    }
    
    std::string line;
    int rank = 0;
    
    // Skip header line if present
    if (std::getline(file, line)) {
        if (line.find("#version") == std::string::npos) {
            // No header, process this line
            std::istringstream iss(line);
            std::string first, second;
            if (iss >> first >> second) {
                bpe_ranks_[{first, second}] = rank++;
            }
        }
    }
    
    // Read merge rules
    while (std::getline(file, line)) {
        if (line.empty() || line[0] == '#') continue;
        
        std::istringstream iss(line);
        std::string first, second;
        if (iss >> first >> second) {
            bpe_ranks_[{first, second}] = rank++;
        }
    }
    
    spdlog::debug("Loaded {} BPE merge rules", bpe_ranks_.size());
}

std::vector<std::pair<std::string, std::string>> BPETokenizer::get_pairs(const std::vector<std::string>& word) {
    std::vector<std::pair<std::string, std::string>> pairs;
    
    if (word.size() < 2) {
        return pairs;
    }
    
    for (size_t i = 0; i < word.size() - 1; ++i) {
        pairs.emplace_back(word[i], word[i + 1]);
    }
    
    return pairs;
}

std::vector<std::string> BPETokenizer::bpe(const std::string& token) {
    // Check cache first
    auto cache_it = cache_.find(token);
    if (cache_it != cache_.end()) {
        return cache_it->second;
    }
    
    // Initialize word as individual characters
    std::vector<std::string> word;
    for (char c : token) {
        word.push_back(std::string(1, c));
    }
    
    if (word.empty()) {
        return word;
    }
    
    // Apply BPE merges
    while (true) {
        auto pairs = get_pairs(word);
        if (pairs.empty()) {
            break;
        }
        
        // Find the pair with the lowest rank (highest priority merge)
        auto min_pair_it = std::min_element(pairs.begin(), pairs.end(),
            [this](const auto& a, const auto& b) {
                auto rank_a = bpe_ranks_.find(a);
                auto rank_b = bpe_ranks_.find(b);
                
                // If pair not in ranks, give it a very high rank (low priority)
                int a_rank = (rank_a != bpe_ranks_.end()) ? rank_a->second : INT_MAX;
                int b_rank = (rank_b != bpe_ranks_.end()) ? rank_b->second : INT_MAX;
                
                return a_rank < b_rank;
            });
        
        // If the minimum pair is not in our merge rules, we're done
        if (bpe_ranks_.find(*min_pair_it) == bpe_ranks_.end()) {
            break;
        }
        
        // Merge the pair
        std::string first = min_pair_it->first;
        std::string second = min_pair_it->second;
        std::vector<std::string> new_word;
        
        size_t i = 0;
        while (i < word.size()) {
            // Look for the pair to merge
            if (i < word.size() - 1 && word[i] == first && word[i + 1] == second) {
                new_word.push_back(first + second);
                i += 2;
            } else {
                new_word.push_back(word[i]);
                i += 1;
            }
        }
        
        word = new_word;
        
        // If we're down to one token, we're done
        if (word.size() == 1) {
            break;
        }
    }
    
    // Cache the result
    cache_[token] = word;
    
    return word;
}

std::vector<int32_t> BPETokenizer::encode(const std::string& text) {
    std::vector<int32_t> token_ids;
    
    if (text.empty()) {
        return token_ids;
    }
    
    // Convert to lowercase for CLIP
    std::string lower_text;
    for (char c : text) {
        lower_text += std::tolower(static_cast<unsigned char>(c));
    }
    
    // Tokenize using regex pattern
    try {
        std::regex pattern(get_pattern(), std::regex::ECMAScript);
        auto words_begin = std::sregex_iterator(lower_text.begin(), lower_text.end(), pattern);
        auto words_end = std::sregex_iterator();
        
        for (auto it = words_begin; it != words_end; ++it) {
            std::string word = it->str();
            
            // Convert word to byte representation
            std::string byte_encoded;
            for (unsigned char c : word) {
                byte_encoded += byte_encoder_[c];
            }
            
            // Apply BPE to the byte-encoded word
            auto bpe_tokens = bpe(byte_encoded);
            
            // Convert BPE tokens to token IDs
            for (const auto& bpe_token : bpe_tokens) {
                auto vocab_it = vocab_.find(bpe_token);
                if (vocab_it != vocab_.end()) {
                    token_ids.push_back(vocab_it->second);
                } else {
                    // Unknown token - this shouldn't happen with a proper vocab
                    spdlog::warn("Unknown BPE token: {}", bpe_token);
                }
            }
        }
    } catch (const std::regex_error& e) {
        spdlog::error("Regex error in tokenization: {}", e.what());
        throw std::runtime_error("Tokenization failed: " + std::string(e.what()));
    }
    
    return token_ids;
}

std::vector<int32_t> BPETokenizer::tokenize(const std::string& text, int context_length) {
    // Encode the text
    std::vector<int32_t> tokens = encode(text);
    
    // Build final token sequence: [SOT, ...tokens..., EOT, ...padding...]
    std::vector<int32_t> result;
    result.reserve(context_length);
    
    // Add start-of-text token
    result.push_back(sot_token());
    
    // Add encoded tokens (truncate if necessary)
    int max_tokens = context_length - 2;  // Reserve space for SOT and EOT
    for (int i = 0; i < std::min(static_cast<int>(tokens.size()), max_tokens); ++i) {
        result.push_back(tokens[i]);
    }
    
    // Add end-of-text token
    result.push_back(eot_token());
    
    // Pad to context_length
    while (result.size() < static_cast<size_t>(context_length)) {
        result.push_back(pad_token());
    }
    
    return result;
}

} // namespace search
} // namespace omni
