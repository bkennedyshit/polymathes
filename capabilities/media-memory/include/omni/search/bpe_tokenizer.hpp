#pragma once

#include <string>
#include <vector>
#include <unordered_map>
#include <map>

namespace omni {
namespace search {

/**
 * BPE (Byte Pair Encoding) tokenizer for CLIP text encoding
 * Implements the tokenization used by OpenAI CLIP models
 */
class BPETokenizer {
public:
    /**
     * Construct BPE tokenizer
     * @param model_dir Directory containing tokenizer files (vocab.json, merges.txt)
     * @throws std::runtime_error if tokenizer files cannot be loaded
     */
    explicit BPETokenizer(const std::string& model_dir);

    /**
     * Tokenize text into token IDs
     * @param text Input text string
     * @param context_length Maximum sequence length (default: 77)
     * @return Token IDs with SOT, EOT, and padding
     */
    std::vector<int32_t> tokenize(const std::string& text, int context_length = 77);

    /**
     * Get the start-of-text token ID
     * @return SOT token ID (49406)
     */
    static constexpr int32_t sot_token() { return 49406; }

    /**
     * Get the end-of-text token ID
     * @return EOT token ID (49407)
     */
    static constexpr int32_t eot_token() { return 49407; }

    /**
     * Get the padding token ID
     * @return Padding token ID (0)
     */
    static constexpr int32_t pad_token() { return 0; }

private:
    // Load vocabulary from JSON file
    void load_vocab(const std::string& vocab_path);

    // Load BPE merges from text file
    void load_merges(const std::string& merges_path);

    // Encode text using BPE algorithm
    std::vector<int32_t> encode(const std::string& text);

    // Get BPE pairs from a word
    std::vector<std::pair<std::string, std::string>> get_pairs(const std::vector<std::string>& word);

    // Apply BPE to a single word
    std::vector<std::string> bpe(const std::string& token);

    // Convert bytes to unicode characters for BPE
    std::string bytes_to_unicode(unsigned char byte);

    // Byte encoder/decoder
    void init_byte_encoder();

    // Vocabulary: token string -> token ID
    std::unordered_map<std::string, int32_t> vocab_;

    // BPE merges: pair -> rank
    std::map<std::pair<std::string, std::string>, int> bpe_ranks_;

    // Byte-level encoding maps
    std::unordered_map<unsigned char, std::string> byte_encoder_;
    std::unordered_map<std::string, unsigned char> byte_decoder_;

    // Cache for BPE results
    std::unordered_map<std::string, std::vector<std::string>> cache_;

    // Regex pattern for tokenization
    static const char* get_pattern();
};

} // namespace search
} // namespace omni
