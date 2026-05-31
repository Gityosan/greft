package main

import "testing"

// Runs the whole golden suite under `go test`, reporting each vector.
func TestAllGoldenVectors(t *testing.T) {
	report := RunAll()
	for _, line := range report.Lines {
		t.Log(line)
	}
	if report.Failed != 0 {
		t.Fatalf("%d conformance vector(s) failed", report.Failed)
	}
}

// Encoder round-trip: encode(decode(golden)) must reproduce the original bytes.
func TestEncoderRoundtrip(t *testing.T) {
	report := RunRoundtrip()
	for _, line := range report.Lines {
		t.Log(line)
	}
	if report.Failed != 0 {
		t.Fatalf("%d round-trip(s) failed", report.Failed)
	}
}
