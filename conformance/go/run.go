package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Report is the outcome of running every golden vector.
type Report struct {
	Passed int
	Failed int
	Lines  []string
}

func goldenDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "spec", "golden")
}

// RunAll decodes and matches every spec/golden/*.bin against its sidecar.
func RunAll() Report {
	dir := goldenDir()
	var report Report

	entries, err := os.ReadDir(dir)
	if err != nil {
		report.Failed++
		report.Lines = append(report.Lines, fmt.Sprintf("  FAIL cannot read %s: %v", dir, err))
		return report
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bin") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		if err := runOne(dir, name); err != nil {
			report.Failed++
			report.Lines = append(report.Lines, fmt.Sprintf("  FAIL %s: %v", name, err))
		} else {
			report.Passed++
			report.Lines = append(report.Lines, fmt.Sprintf("  ok   %s", name))
		}
	}
	return report
}

func runOne(dir, name string) error {
	bin, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return err
	}
	metaSrc, err := os.ReadFile(filepath.Join(dir, strings.TrimSuffix(name, ".bin")+".meta.json"))
	if err != nil {
		return err
	}
	decoded, err := Decode(bin)
	if err != nil {
		return err
	}
	var meta map[string]interface{}
	if err := json.Unmarshal(metaSrc, &meta); err != nil {
		return err
	}
	return MatchVector(decoded, meta)
}

func main() {
	report := RunAll()
	fmt.Printf("Graft conformance — Go port (%d vectors)\n\n", report.Passed+report.Failed)
	for _, line := range report.Lines {
		fmt.Println(line)
	}
	fmt.Printf("\n%d passed, %d failed\n", report.Passed, report.Failed)
	if report.Failed != 0 {
		os.Exit(1)
	}
}
