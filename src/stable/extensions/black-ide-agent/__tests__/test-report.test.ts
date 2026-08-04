import {
    selectTestCommand, parseTestOutput, formatTestReport,
    parsePytest, parseJest, parseVitest, parseDotnet, parseCargo, parseGo, parseRspec,
} from '@blackide/agent-core/core/test-report';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';

/**
 * Phase 1 (M8). Output samples below are shaped like real runner output, including
 * the duplicated headers and per-target summaries that make naive parsing wrong.
 */

const profile = (over: Partial<ProjectProfile>): ProjectProfile => ({
    languages: [], frameworks: [], testFrameworks: [], packageManagers: [],
    stacks: [], confidence: 1, evidence: [], ...over,
});

describe('selectTestCommand', () => {
    it('prefers an explicit test-framework signal over a language default', () => {
        const cmd = selectTestCommand(profile({ languages: ['python'], testFrameworks: ['pytest'] }));
        expect(cmd).toEqual({ framework: 'pytest', command: 'python -m pytest -q' });
    });

    it('falls back to the language default for built-in runners', () => {
        expect(selectTestCommand(profile({ languages: ['rust'] }))?.framework).toBe('cargo');
        expect(selectTestCommand(profile({ languages: ['go'] }))?.command).toBe('go test ./...');
    });

    it('maps every .NET test framework to dotnet test', () => {
        for (const fw of ['xunit', 'nunit', 'mstest']) {
            expect(selectTestCommand(profile({ testFrameworks: [fw] }))?.framework).toBe('dotnet');
        }
    });

    it('returns undefined when nothing is detected, rather than guessing', () => {
        expect(selectTestCommand(profile({}))).toBeUndefined();
    });

    it('threads scope into the command', () => {
        expect(selectTestCommand(profile({ testFrameworks: ['pytest'] }), 'tests/test_api.py')?.command)
            .toBe('python -m pytest -q tests/test_api.py');
        // go needs the path in place of ./... rather than appended after it
        expect(selectTestCommand(profile({ languages: ['go'] }), './internal/...')?.command)
            .toBe('go test ./internal/...');
    });
});

describe('parsePytest', () => {
    const out = `....F                                                          [100%]
=================================== FAILURES ===================================
_________________________________ test_orders __________________________________
    def test_orders():
>       assert total == 2
E       assert 1 == 2
=========================== short test summary info ============================
FAILED tests/test_api.py::test_orders - assert 1 == 2
========================= 1 failed, 4 passed in 0.12s ==========================`;

    it('extracts the failing node id and its assertion', () => {
        const r = parsePytest(out);
        expect(r.failures).toEqual([{ name: 'tests/test_api.py::test_orders', message: 'assert 1 == 2' }]);
    });

    it('reads the summary tally', () => {
        const r = parsePytest(out);
        expect(r.failed).toBe(1);
        expect(r.passed).toBe(4);
    });

    it('handles an all-green run', () => {
        const r = parsePytest('.....                    [100%]\n===== 5 passed in 0.30s =====');
        expect(r.failures).toEqual([]);
        expect(r.passed).toBe(5);
        expect(r.failed).toBeUndefined();
    });

    it('counts collection ERRORs as failures too', () => {
        const r = parsePytest('ERROR tests/test_x.py - ImportError: no module named foo\n=== 1 error in 0.1s ===');
        expect(r.failures[0].name).toBe('tests/test_x.py');
    });
});

describe('parseJest', () => {
    // jest prints the ● header twice: once in the failure block, once in the summary.
    const out = ` FAIL  test/users.test.ts
  ● users › returns 200

    expect(received).toBe(expected)

  ● users › returns 200

      at Object.<anonymous> (test/users.test.ts:12:20)

Tests:       1 failed, 2 passed, 3 total`;

    it('deduplicates the repeated failure header', () => {
        const r = parseJest(out);
        expect(r.failures).toEqual([{ name: 'users › returns 200' }]);
    });

    it('reads the Tests: tally', () => {
        const r = parseJest(out);
        expect(r.failed).toBe(1);
        expect(r.passed).toBe(2);
    });

    it('ignores Console blocks, which also use the bullet', () => {
        const r = parseJest('  ● Console\n\n    console.log\n\nTests:       1 passed, 1 total');
        expect(r.failures).toEqual([]);
    });
});

describe('parseVitest', () => {
    const out = ` ❯ src/x.test.ts (2 tests | 1 failed)
   × suite > adds numbers
     → expected 3 to be 4

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)`;

    it('extracts the failing case and tally', () => {
        const r = parseVitest(out);
        expect(r.failures).toEqual([{ name: 'suite > adds numbers' }]);
        expect(r.failed).toBe(1);
        expect(r.passed).toBe(1);
    });

    it('does not double-count the per-file FAIL banner', () => {
        const r = parseVitest(' FAIL  src/x.test.ts\n × src/x.test.ts\n      Tests  1 failed (1)');
        expect(r.failures).toHaveLength(1);
    });
});

describe('parseDotnet', () => {
    const out = `  Failed UsersTests.Returns200 [12 ms]
  Error Message:
   Assert.Equal() Failure
Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3`;

    it('extracts the failed case and the tally', () => {
        const r = parseDotnet(out);
        expect(r.failures[0].name).toBe('UsersTests.Returns200');
        expect(r.failed).toBe(1);
        expect(r.passed).toBe(2);
        expect(r.skipped).toBe(0);
    });
});

describe('parseCargo', () => {
    // A workspace prints one summary per crate; the counts have to be summed.
    const out = `test tests::health_ok ... ok
test tests::health_json ... FAILED

failures:
---- tests::health_json stdout ----
thread panicked at src/main.rs:42:5: assertion failed

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out`;

    it('extracts the failing test path', () => {
        expect(parseCargo(out).failures).toEqual([{ name: 'tests::health_json' }]);
    });

    it('sums counts across crate targets', () => {
        const r = parseCargo(out);
        expect(r.passed).toBe(4);
        expect(r.failed).toBe(1);
        expect(r.skipped).toBe(1);
    });
});

describe('parseGo', () => {
    const out = `--- FAIL: TestUsers (0.00s)
    users_test.go:12: expected 200, got 500
FAIL
FAIL	example.com/svc/internal/handlers	0.003s
ok  	example.com/svc/internal/store	0.002s`;

    it('extracts failing test names', () => {
        expect(parseGo(out).failures).toEqual([{ name: 'TestUsers' }]);
    });

    it('leaves passed undefined rather than counting ok packages as tests', () => {
        // Two `ok`/`FAIL` package lines exist, but they are packages, not test cases.
        expect(parseGo(out).passed).toBeUndefined();
    });

    it('counts cases when -v was used', () => {
        expect(parseGo('--- PASS: TestA (0.00s)\n--- PASS: TestB (0.00s)').passed).toBe(2);
    });
});

describe('parseRspec', () => {
    const out = `Failures:

  1) Order creates a line item
     Failure/Error: expect(order).to be_valid

3 examples, 1 failure, 1 pending`;

    it('extracts the failure and derives passed from the tally', () => {
        const r = parseRspec(out);
        expect(r.failures[0].name).toBe('Order creates a line item');
        expect(r.failed).toBe(1);
        expect(r.skipped).toBe(1);
        expect(r.passed).toBe(1); // 3 total - 1 failed - 1 pending
    });
});

describe('parseTestOutput trusts the exit code', () => {
    it('does not report ok when the process failed but printed no failures', () => {
        const r = parseTestOutput('pytest', { stdout: 'ImportError while loading conftest', exitCode: 4 });
        expect(r.ok).toBe(false);
    });

    it('does not report ok on a timeout even with a clean-looking parse', () => {
        const r = parseTestOutput('pytest', { stdout: '===== 5 passed in 1s =====', exitCode: 0, timedOut: true });
        expect(r.ok).toBe(false);
    });

    it('reports ok for a genuine clean run', () => {
        const r = parseTestOutput('pytest', { stdout: '===== 5 passed in 1s =====', exitCode: 0 });
        expect(r.ok).toBe(true);
        expect(r.passed).toBe(5);
    });

    it('flags an unknown framework instead of claiming success', () => {
        const r = parseTestOutput('mystery-runner', { stdout: 'whatever', exitCode: 1 });
        expect(r.unparsed).toBe(true);
        expect(r.ok).toBe(false);
    });
});

describe('formatTestReport', () => {
    it('collapses a huge noisy run into a small failures-only report', () => {
        // 800 passing pytest cases plus one failure — the exact shape that made raw
        // `run_command` test runs unaffordable.
        const noise = Array.from({ length: 800 }, (_, i) => `tests/test_bulk.py::test_case_${i} PASSED`).join('\n');
        const raw = `${noise}
=================================== FAILURES ===================================
FAILED tests/test_api.py::test_orders - assert 1 == 2
========================= 1 failed, 800 passed in 12.30s =======================`;

        expect(raw.length).toBeGreaterThan(30_000);

        const report = parseTestOutput('pytest', { stdout: raw, exitCode: 1 }, 'python -m pytest -q');
        const formatted = formatTestReport(report);

        // The Phase 1 gate: a failing suite comes back small.
        expect(formatted.length).toBeLessThan(2048);
        expect(formatted).toContain('800 passed');
        expect(formatted).toContain('test_orders');
        // And it must not carry the passing-test noise.
        expect(formatted).not.toContain('test_case_500');
    });

    it('states plainly when a non-zero exit had no test failures', () => {
        const report = parseTestOutput('pytest', { stdout: 'ImportError while loading conftest.py', exitCode: 4 });
        const formatted = formatTestReport(report);
        expect(formatted).toContain('build or configuration error');
    });

    it('never reports a timeout as a pass', () => {
        const report = parseTestOutput('jest', { stdout: '', exitCode: 0, timedOut: true });
        expect(formatTestReport(report)).toContain('not as a pass');
    });

    it('caps the failure list and says how many were withheld', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `FAILED tests/t.py::test_${i} - boom`).join('\n');
        const report = parseTestOutput('pytest', { stdout: `${lines}\n===== 30 failed, 0 passed in 1s =====`, exitCode: 1 });
        expect(report.failures).toHaveLength(20);
        expect(formatTestReport(report)).toContain('10 more failure');
    });
});
