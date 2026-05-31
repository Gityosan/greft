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
