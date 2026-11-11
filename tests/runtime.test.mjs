import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = process.env.FIREFOX_TEST_TMPDIR || path.join(root, "temp", "tests");
mkdirSync(tempRoot, { recursive: true });
const tools = path.join(root, "rootfs", "usr", "share", "firefox-tools").replaceAll("\\", "/");
const shell = process.env.FIREFOX_TEST_SHELL || "/bin/sh";
const bash = process.env.FIREFOX_TEST_BASH || (process.platform === "win32" ? shell : "/bin/bash");
const baseEnvironment = { ...process.env };
for (const key of Object.keys(baseEnvironment)) {
    if (key.startsWith("FF_PREF_") || key === "FF_CUSTOM_ARGS" || key === "FF_OPEN_URL") {
        delete baseEnvironment[key];
    }
}

function run(script, environment = {}, args = [], prefix = "") {
    const source = readFileSync(path.join(root, script), "utf8")
        .replaceAll("/usr/share/firefox-tools", tools);
    const result = spawnSync(shell, ["-s", "--", ...args], {
        input: prefix + source,
        encoding: "utf8",
        env: { ...baseEnvironment, ...environment },
        cwd: root,
        timeout: 10000,
    });
    if (result.error) throw result.error;
    return result;
}

function params(environment) {
    const script = "rootfs/etc/services.d/app/params";
    const source = readFileSync(path.join(root, script), "utf8")
        .replaceAll("/usr/share/firefox-tools", tools)
        .replaceAll("is-bool-val-true", "is_bool_val_true");
    const result = spawnSync(shell, ["-s"], {
        input: `is_bool_val_true() { [ "$1" = 1 ]; }\n${source}`,
        encoding: "utf8",
        env: { ...baseEnvironment, ...environment },
        cwd: root,
        timeout: 10000,
    });
    if (result.error) throw result.error;
    return result;
}

function fixture(contents = "") {
    const directory = mkdtempSync(path.join(tempRoot, "prefs-"));
    const file = path.join(directory, "prefs.js");
    writeFileSync(file, contents, { mode: 0o600 });
    return { directory, file };
}

function setPrefs(file, environment) {
    return run("rootfs/etc/cont-init.d/56-firefox-set-prefs-from-env.sh", environment, [file]);
}

test("parameters keep the profile, kiosk switch and multiple URLs in order", () => {
    const result = params({
        FF_KIOSK: "1",
        FF_CUSTOM_ARGS: '--new-window "https://example.test/a b"',
        FF_OPEN_URL: "https://example.test/one|https://example.test/two",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
        "--profile", "/config/profile", "--setDefaultBrowser", "--kiosk",
        "--new-window", "https://example.test/a b",
        "https://example.test/one", "https://example.test/two",
    ]);
});

test("quotes, escaped spaces and concatenated words are parsed literally", () => {
    const result = params({ FF_CUSTOM_ARGS: String.raw`--name='one two' three\ four "five\"six" 'seven\eight'` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n").slice(3), [
        "--name=one two", "three four", 'five"six', String.raw`seven\eight`,
    ]);
});

test("custom arguments never execute shell substitutions or redirections", () => {
    const directory = mkdtempSync(path.join(tempRoot, "args-"));
    const sentinel = path.join(directory, "unexpected").replaceAll("\\", "/");
    const result = params({ FF_CUSTOM_ARGS: `$(touch "${sentinel}") ; echo injected > "${sentinel}"` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sentinel), false);
    assert.match(result.stdout, /\$\(touch/);
});

for (const value of ["'unfinished", '"unfinished', "unfinished\\", "one\n--headless", '""']) {
    test(`invalid custom arguments fail: ${JSON.stringify(value)}`, () => {
        const result = params({ FF_CUSTOM_ARGS: value });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ERROR: FF_CUSTOM_ARGS/);
    });
}

test("empty URL segments are skipped and echo options are not interpreted", () => {
    const result = params({ FF_OPEN_URL: "|https://example.test/a?x=1&y=2||about:blank|" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n").slice(3), [
        "https://example.test/a?x=1&y=2", "about:blank",
    ]);
    assert.notEqual(params({ FF_OPEN_URL: "-n" }).status, 0);
    assert.notEqual(params({ FF_OPEN_URL: "https://example.test/\n--headless" }).status, 0);
});

test("preference replacement is literal, not a regular expression", () => {
    const { file } = fixture([
        "// retained comment",
        'user_pref("test.pref", 1);',
        'user_pref("testXpref", 7);',
        'user_pref("test[0]/pref", 3);',
        'user_pref("other.pref", true);',
        "",
    ].join("\n"));
    const result = setPrefs(file, {
        FF_PREF_REPLACE: "test.pref=2",
        FF_PREF_UNSET: "test[0]/pref=UNSET",
    });
    assert.equal(result.status, 0, result.stderr);
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /user_pref\("test\.pref", 2\);/);
    assert.ok(contents.includes('user_pref("testXpref", 7);'));
    assert.ok(contents.includes('user_pref("other.pref", true);'));
    assert.ok(contents.includes("// retained comment"));
    assert.ok(!contents.includes('user_pref("test[0]/pref",'));
});

test("escaped preference strings retain their JSON meaning", () => {
    const { file } = fixture();
    const literal = JSON.stringify('C:\\downloads\\a"b\nc\u4e2d=/&');
    const result = setPrefs(file, { FF_PREF_STRING: `test.string=${literal}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), `user_pref("test.string", ${literal});\n`);
});

test("booleans, integer boundaries and empty string preferences are accepted", () => {
    const { file } = fixture();
    const result = setPrefs(file, {
        FF_PREF_MIN: "test.min=-2147483648",
        FF_PREF_MAX: "test.max=2147483647",
        FF_PREF_TRUE: "test.true=true",
        FF_PREF_FALSE: "test.false=false",
        FF_PREF_EMPTY: "test.empty=",
        FF_PREF_NAME: "test.name",
    });
    assert.equal(result.status, 0, result.stderr);
    const contents = readFileSync(file, "utf8");
    for (const expected of [
        'user_pref("test.min", -2147483648);', 'user_pref("test.max", 2147483647);',
        'user_pref("test.true", true);', 'user_pref("test.false", false);',
        'user_pref("test.empty", "");', 'user_pref("test.name", "");',
    ]) assert.ok(contents.includes(expected), expected);
});

for (const value of [
    "test.pref=true); user_pref(\"injected\", true); //",
    "test.pref=2147483648",
    "test.pref=-2147483649",
    "test.pref=1.5",
    "test.pref=01",
    'test.pref="unterminated',
    String.raw`test.pref="bad\escape"`,
    String.raw`test.pref="bad\u123"`,
    'test.pref="raw\nnewline"',
    'bad"name=true',
    "=true",
]) {
    test(`invalid preferences leave the original file untouched: ${JSON.stringify(value)}`, () => {
        const initial = 'user_pref("retained", 42);\n';
        const { file, directory } = fixture(initial);
        const mode = statSync(file).mode;
        const result = setPrefs(file, { FF_PREF_INVALID: value, FF_PREF_VALID: "test.valid=true" });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ERROR: FF_PREF_INVALID/);
        assert.equal(readFileSync(file, "utf8"), initial);
        assert.equal(statSync(file).mode, mode);
        assert.ok(!existsSync(path.join(directory, "injected")));
        assert.ok(!result.stderr.includes(value));
    });
}

test("duplicate preference names fail instead of choosing a random environment order", () => {
    const { file } = fixture("// unchanged\n");
    const result = setPrefs(file, { FF_PREF_ONE: "test.pref=1", FF_PREF_TWO: "test.pref=2" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(file, "utf8"), "// unchanged\n");
});

test("no preference environment variables preserve the existing file", () => {
    const original = '// a comment\nuser_pref("test.pref", true);\n';
    const { file } = fixture(original);
    assert.equal(setPrefs(file, {}).status, 0);
    assert.equal(readFileSync(file, "utf8"), original);
});

test("all runtime shell entry points pass the shell syntax check", () => {
    for (const script of [
        "rootfs/startapp.sh",
        "rootfs/etc/cont-init.d/55-firefox.sh",
        "rootfs/etc/cont-init.d/56-firefox-set-prefs-from-env.sh",
        "rootfs/etc/services.d/app/params",
        "rootfs/etc/services.d/app/kill",
        "rootfs/etc/services.d/firefox-logrotate/run",
        "rootfs/usr/share/firefox-tools/healthcheck.sh",
        "src/nspr/build.sh",
    ]) {
        const result = spawnSync(shell, ["-n"], {
            input: readFileSync(path.join(root, script), "utf8"),
            encoding: "utf8",
        });
        assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
});

test("both build paths restore executable scripts and the machine-id symlink", () => {
    for (const dockerfile of ["Dockerfile", "Dockerfile.hanging"]) {
        const contents = readFileSync(path.join(root, dockerfile), "utf8");
        assert.match(contents, /chmod 755/);
        assert.ok(contents.includes("/etc/services.d/firefox-logrotate/run"));
        assert.ok(contents.includes("/usr/share/firefox-tools/healthcheck.sh"));
        assert.ok(contents.includes("ln -snf /config/machine-id /etc/machine-id"));
    }
    const dockerignore = readFileSync(path.join(root, ".dockerignore"), "utf8");
    assert.ok(dockerignore.includes("\nrootfs/etc/machine-id\n"));
});

test("Firefox logs use copytruncate with finite retention and a periodic service", () => {
    const config = readFileSync(path.join(root, "rootfs/etc/firefox/logrotate.conf"), "utf8");
    for (const setting of ["size 1M", "rotate 2", "nodateext", "copytruncate"]) {
        assert.ok(config.includes(setting));
    }
    assert.equal(readFileSync(path.join(root, "rootfs/etc/services.d/firefox-logrotate/interval"), "utf8").trim(), "300");
    assert.equal(readFileSync(path.join(root, "rootfs/etc/services.d/default/firefox-logrotate.dep"), "utf8").trim(), "true");
});

test("shutdown targets only the Firefox window belonging to the service PID", () => {
    const { file } = fixture();
    const prefix = `
xdotool() {
    printf '%s\\n' "$*" >> "$TEST_XDOTOOL_LOG"
    if [ "$1" = search ]; then printf '42\\n'; fi
}
kill() { return 1; }
`;
    const result = run("rootfs/etc/services.d/app/kill", { TEST_XDOTOOL_LOG: file }, ["123456"], prefix);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(file, "utf8").trimEnd().split("\n"), [
        "search --onlyvisible --all --pid 123456 --class firefox",
        "key --window 42 Escape ctrl+q",
    ]);
    assert.notEqual(run("rootfs/etc/services.d/app/kill", {}, ["1"]).status, 0);
});

function healthcheck(snapshot, display = "") {
    const { file } = fixture(snapshot);
    return run("rootfs/usr/share/firefox-tools/healthcheck.sh", { DISPLAY: display }, [file], `
xdotool() { printf '%s|%s\\n' "$DISPLAY" "$*"; }
`);
}

test("healthcheck uses the display selected during container initialization", () => {
    const result = healthcheck('export DISPLAY=":3.0"\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ":3.0|search --onlyvisible --class firefox\n");
});

test("healthcheck respects an explicitly configured display", () => {
    const result = healthcheck("", ":7");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ":7|search --onlyvisible --class firefox\n");
});

test("healthcheck never evaluates commands in the environment snapshot", () => {
    const { directory } = fixture();
    const sentinel = path.join(directory, "unexpected").replaceAll("\\", "/");
    const result = healthcheck(`export OTHER="$(touch '${sentinel}')"\nexport DISPLAY=":2"\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sentinel), false);
    assert.equal(result.stdout, ":2|search --onlyvisible --class firefox\n");
});

test("healthcheck rejects missing or malformed initialized displays", () => {
    for (const snapshot of ["", 'export DISPLAY=":0"; echo injected\n', 'export DISPLAY="$(echo :0)"\n']) {
        const result = healthcheck(snapshot);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
    }
});

const workflow = readFileSync(path.join(root, ".github/workflows/build-image.yml"), "utf8");
const prepareBlock = workflow.split("      - name: Prepare image tags\n")[1]
    .split("      - name: Set up QEMU\n")[0]
    .split("        run: |\n")[1]
    .split("\n").map(line => line.slice(10)).join("\n");

function imageTags(reference, event = "push") {
    const { file } = fixture();
    const result = spawnSync(bash, ["-s"], {
        input: prepareBlock,
        encoding: "utf8",
        env: {
            ...baseEnvironment,
            GITHUB_REPOSITORY: "ExampleOwner/Docker-Firefox",
            GITHUB_SHA: "123456789abcdef0123456789abcdef0123456789",
            GITHUB_REF: reference,
            GITHUB_EVENT_NAME: event,
            DEFAULT_BRANCH: "main",
            GITHUB_OUTPUT: file,
        },
        timeout: 10000,
    });
    if (result.error) throw result.error;
    return { ...result, output: readFileSync(file, "utf8") };
}

test("default-branch builds publish to the fork's lower-case GHCR path", () => {
    const result = imageTags("refs/heads/main");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, [
        "tags=ghcr.io/exampleowner/docker-firefox:sha-123456789abc,ghcr.io/exampleowner/docker-firefox:latest",
        "publish=true", "",
    ].join("\n"));
});

test("version tags publish the version without replacing latest", () => {
    const result = imageTags("refs/tags/v1.1");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /docker-firefox:1\.1\npublish=true/);
    assert.ok(!result.output.includes(":latest"));
});

test("PRs and non-default branches never publish", () => {
    for (const result of [
        imageTags("refs/pull/12/merge", "pull_request"),
        imageTags("refs/heads/main", "pull_request"),
        imageTags("refs/heads/fix/startup"),
    ]) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.output, /publish=false/);
        assert.ok(!result.output.includes(":latest"));
    }
});

test("malformed image tags are rejected", () => {
    const result = imageTags("refs/tags/vbad/name");
    assert.notEqual(result.status, 0);
    assert.ok(result.stdout.includes("Invalid Docker version tag"));
});

test("all inline workflow shell programs pass the syntax check", () => {
    const blocks = workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm);
    let count = 0;
    for (const block of blocks) {
        const result = spawnSync(bash, ["-n"], {
            input: block[1].split("\n").map(line => line.slice(10)).join("\n"),
            encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        count++;
    }
    assert.equal(count, 3);
});
