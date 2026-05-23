package main

import "math"

// pcmSlice extracts a slice of int16 PCM samples by time range (seconds).
func pcmSlice(samples []int16, sampleRate int, startSec, endSec float64) []int16 {
	if sampleRate <= 0 {
		sampleRate = 16000
	}
	start := int(startSec * float64(sampleRate))
	end := int(endSec * float64(sampleRate))
	if start < 0 {
		start = 0
	}
	if end > len(samples) {
		end = len(samples)
	}
	if start >= end {
		return nil
	}
	return samples[start:end]
}

// EstimatePitch estimates the fundamental frequency (Hz) of a PCM audio slice
// using the Average Magnitude Difference Function (AMDF). Returns 0 if the
// audio is too short or no clear pitch is found.
func EstimatePitch(samples []int16, sampleRate int) float64 {
	if sampleRate <= 0 {
		sampleRate = 16000
	}
	minSamples := sampleRate * 3 / 10 // 300ms minimum
	if len(samples) < minSamples {
		return 0
	}

	// Downsample to ~8kHz for faster computation
	step := sampleRate / 8000
	if step < 1 {
		step = 1
	}
	var downsampled []float64
	for i := 0; i < len(samples); i += step {
		downsampled = append(downsampled, float64(samples[i]))
	}
	effRate := float64(sampleRate) / float64(step)

	return estimatePitchAMDF(downsampled, int(effRate))
}

// DetectGender estimates whether a PCM audio slice is male or female speech.
// Returns "male", "female", or "" (unknown / audio too short).
//
// NOTE: this is a single-segment "snapshot" decision and may flip on borderline
// segments (a male speaker excited to ~170 Hz can briefly land in the female
// zone). For session-level stability, callers should track gender history and
// only flip on strong-confidence detections — see DetectGenderConfidence.
func DetectGender(samples []int16, sampleRate int) string {
	g, _ := DetectGenderConfidence(samples, sampleRate)
	return g
}

// DetectGenderConfidence returns gender plus a confidence label:
//
//	"strong" — pitch is clearly inside male (<140 Hz) or female (>195 Hz) zone
//	"weak"   — pitch is in the ambiguous 140–195 Hz band; the snap decision
//	           is unreliable and callers should prefer prior history
//	""       — no pitch found (silence / too short / noise)
//
// Why the bands are tight: male fundamental commonly extends up to ~180 Hz
// when excited/raised, and female down to ~165 Hz when calm. An excited male
// shouting can briefly hit 190 Hz, so we keep strong-female at >195 Hz to
// avoid mis-flipping. The earlier 145/185 thresholds were too lenient — an
// emphatic male voice would trip strong-female and cause sticky-flip
// candidates to accumulate. With the wider ambiguous band the per-segment
// "weak" verdict is suppressed by the sticky layer (see resolveStickyGender).
func DetectGenderConfidence(samples []int16, sampleRate int) (gender, confidence string) {
	pitch := EstimatePitch(samples, sampleRate)
	if pitch <= 0 {
		return "", ""
	}
	switch {
	case pitch < 140:
		return "male", "strong"
	case pitch > 195:
		return "female", "strong"
	case pitch < 165:
		return "male", "weak"
	default:
		return "female", "weak"
	}
}

// classifyPitch maps a fundamental frequency (Hz) to "male" or "female".
// Male: 85–180 Hz, Female: 165–255 Hz. Threshold at 160 Hz.
// Kept for backwards compatibility — new code should use DetectGenderConfidence.
func classifyPitch(hz float64) string {
	if hz < 160 {
		return "male"
	}
	return "female"
}

// estimatePitchAMDF estimates fundamental frequency using the Average
// Magnitude Difference Function on downsampled float64 samples.
// Prefers lower frequencies to avoid octave errors (picking a harmonic
// instead of the true fundamental).
func estimatePitchAMDF(samples []float64, sampleRate int) float64 {
	if len(samples) < 2 {
		return 0
	}

	// Search range: 70 Hz – 300 Hz
	minLag := sampleRate / 300
	maxLag := sampleRate / 70
	if minLag < 5 {
		minLag = 5
	}
	if maxLag >= len(samples)/2 {
		maxLag = len(samples)/2 - 1
	}
	if maxLag <= minLag {
		return 0
	}

	// Compute AMDF for all lags
	amdf := make([]float64, maxLag+1)
	bestVal := math.MaxFloat64
	for lag := minLag; lag <= maxLag; lag++ {
		var sum float64
		n := len(samples) - lag
		for i := 0; i < n; i++ {
			diff := samples[i] - samples[i+lag]
			if diff < 0 {
				diff = -diff
			}
			sum += diff
		}
		amdf[lag] = sum / float64(n)
		if amdf[lag] < bestVal {
			bestVal = amdf[lag]
		}
	}

	// Scan from maxLag (lowest freq) down to minLag, pick the first lag
	// whose AMDF is within 15% of the global minimum. This prefers the
	// fundamental over harmonics (octave error correction).
	threshold := bestVal * 1.15
	for lag := maxLag; lag >= minLag; lag-- {
		if amdf[lag] <= threshold {
			return float64(sampleRate) / float64(lag)
		}
	}

	return 0
}
