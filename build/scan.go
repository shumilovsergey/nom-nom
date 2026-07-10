package main

// scan.go — Claude vision/text nutrition estimation (adapted from old-version/go/api.go).
// Both modes (photo, free-text description) return the same nutrition JSON, which the
// UI uses to prefill the meal sheet for the user to review and save.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// defaultScanModel is only a fallback — the model is read from SCAN_MODEL at startup
// so every Claude model can be A/B tested without a rebuild.
const defaultScanModel = "claude-opus-4-8"

var scanModel = defaultScanModel // set from env in main()

// aiProxyURL / aiProxySecret point at our proxy-project, which holds the real
// Anthropic key and forwards the Messages payload byte-for-byte. nom-nom never
// sees the Anthropic key; it authenticates to the proxy with a shared secret.
// Both are set from env in main() (AI_PROXY_URL / AI_PROXY_SECRET).
var (
	aiProxyURL    string
	aiProxySecret string
)

var errNoCredits = errors.New("no credits")

const scanSystemPrompt = `You are a nutrition expert. Estimate the nutritional content of the food for the visible/described portion.
Respond with ONLY a valid JSON object in this exact format, no other text:
{"name": "food name in Russian", "grams": estimated_grams, "calories": estimated_calories, "proteins": estimated_proteins_g, "fats": estimated_fats_g, "carbs": estimated_carbs_g}`

// ScanResult is what the frontend meal sheet consumes (mirrors MealInput + carbs).
type ScanResult struct {
	Name  string  `json:"name"`
	Grams int     `json:"grams"`
	Kcal  int     `json:"kcal"`
	Prot  float64 `json:"prot"`
	Fat   float64 `json:"fat"`
	Carb  float64 `json:"carb"`
}

// photoContent builds the message content for an image scan.
func photoContent(imageBase64, mediaType string) []map[string]any {
	if mediaType == "" {
		mediaType = "image/jpeg"
	}
	return []map[string]any{
		{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": mediaType,
				"data":       imageBase64,
			},
		},
		{"type": "text", "text": "What food is this? Estimate name, grams, calories and macros."},
	}
}

// textContent builds the message content for a free-text description scan.
func textContent(description string) []map[string]any {
	return []map[string]any{
		{"type": "text", "text": "Estimate the nutrition for this meal: " + description},
	}
}

// scanTimeout bounds one Claude call — without it a hung upstream request would
// freeze the scan forever (photo scans legitimately run up to ~15s on Opus).
const scanTimeout = 20 * time.Second

// scanWithClaude calls the Anthropic API and parses the nutrition JSON out of the
// reply. The context ties the upstream call to the HTTP request: if the browser
// gives up and aborts, the Claude call is canceled too instead of burning tokens.
func scanWithClaude(ctx context.Context, content []map[string]any) (*ScanResult, error) {
	if aiProxyURL == "" || aiProxySecret == "" {
		return nil, fmt.Errorf("AI_PROXY_URL / AI_PROXY_SECRET not set")
	}

	payload := map[string]any{
		"model":      scanModel,
		"max_tokens": 256,
		"system":     scanSystemPrompt,
		"messages": []map[string]any{
			{"role": "user", "content": content},
		},
	}

	ctx, cancel := context.WithTimeout(ctx, scanTimeout)
	defer cancel()

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", aiProxyURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+aiProxySecret)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		log.Printf("anthropic error status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(b)))
		if resp.StatusCode == http.StatusPaymentRequired {
			return nil, errNoCredits
		}
		var apiErr struct {
			Error struct {
				Type string `json:"type"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &apiErr) == nil && apiErr.Error.Type == "billing_error" {
			return nil, errNoCredits
		}
		return nil, fmt.Errorf("claude api error %d", resp.StatusCode)
	}

	var claudeResp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&claudeResp); err != nil {
		return nil, err
	}
	if len(claudeResp.Content) == 0 {
		return nil, fmt.Errorf("empty response from claude")
	}

	text := strings.TrimSpace(claudeResp.Content[0].Text)
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start == -1 || end == -1 || end < start {
		return nil, fmt.Errorf("no JSON in response")
	}

	// Claude returns the API's natural key names; map them onto ScanResult.
	var raw struct {
		Name     string  `json:"name"`
		Grams    float64 `json:"grams"`
		Calories float64 `json:"calories"`
		Proteins float64 `json:"proteins"`
		Fats     float64 `json:"fats"`
		Carbs    float64 `json:"carbs"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &raw); err != nil {
		return nil, fmt.Errorf("parse result: %w", err)
	}
	return &ScanResult{
		Name:  raw.Name,
		Grams: int(raw.Grams),
		Kcal:  int(raw.Calories),
		Prot:  raw.Proteins,
		Fat:   raw.Fats,
		Carb:  raw.Carbs,
	}, nil
}
