package check

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const observationSource = "qoder.raw_sse.body.model"
const maxObservationBytes = 16 * 1024

var observationID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,160}$`)

type upstreamObservation struct {
	Schema        int      `json:"schema"`
	ResponseID    string   `json:"response_id"`
	Provider      string   `json:"provider"`
	SentModel     string   `json:"sent_model"`
	ResponseModel string   `json:"response_model"`
	Models        []string `json:"models"`
	Conflict      bool     `json:"conflict"`
	Source        string   `json:"source"`
	CapturedAt    string   `json:"captured_at"`
}

// applyUpstreamObservation only accepts a matching, bounded metadata receipt.
// Gateway headers and body fields are deliberately never used as upstream models.
func applyUpstreamObservation(out *RouteCheck, dir string, started, now time.Time) {
	if dir == "" || !observationID.MatchString(out.ResponseID) || out.Provider != "qoder" {
		return
	}
	f, err := os.Open(filepath.Join(dir, out.ResponseID+".json"))
	if err != nil {
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxObservationBytes+1))
	if err != nil || len(raw) > maxObservationBytes {
		return
	}
	var receipt upstreamObservation
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&receipt) != nil || dec.Decode(&struct{}{}) != io.EOF {
		return
	}
	if receipt.Schema != 1 || receipt.ResponseID != out.ResponseID || receipt.Provider != out.Provider || receipt.Source != observationSource {
		return
	}
	captured, err := time.Parse(time.RFC3339Nano, receipt.CapturedAt)
	if err != nil || captured.Before(started.Add(-30*time.Second)) || captured.After(now.Add(30*time.Second)) || captured.Before(now.Add(-10*time.Minute)) {
		return
	}
	validModel := func(s string) bool {
		return utf8.ValidString(s) && strings.TrimSpace(s) != "" && utf8.RuneCountInString(strings.TrimSpace(s)) <= 200
	}
	if receipt.SentModel != "" && !validModel(receipt.SentModel) {
		return
	}
	if len(receipt.Models) > 16 {
		return
	}
	seen := make(map[string]bool, len(receipt.Models))
	models := make([]string, 0, len(receipt.Models))
	for _, model := range receipt.Models {
		if !validModel(model) {
			return
		}
		model = strings.TrimSpace(model)
		if seen[model] {
			return
		}
		seen[model] = true
		models = append(models, model)
	}
	responseModel := strings.TrimSpace(receipt.ResponseModel)
	if receipt.ResponseModel != "" && (!validModel(receipt.ResponseModel) || !seen[responseModel]) {
		return
	}
	if responseModel == "" && len(models) != 0 {
		return
	}
	out.UpstreamSentModel = strings.TrimSpace(receipt.SentModel)
	out.UpstreamSource = receipt.Source
	out.UpstreamModels = models
	out.UpstreamConflict = receipt.Conflict || len(models) > 1
	if responseModel == "" {
		out.UpstreamStatus = "not_returned"
	} else {
		out.UpstreamStatus = "observed"
		out.UpstreamModel = responseModel
	}
}
