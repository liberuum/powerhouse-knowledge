#!/usr/bin/env python3
"""
Tests for the PreToolUse hooks. Run: python3 hooks/test_hooks.py

Each hook is exercised the way Claude Code runs it — as a subprocess with the
tool call as JSON on stdin — so what is tested is the contract (exit code,
stderr, updatedInput), not internals. The identity hook shells out to
`switchboard auth status`; a fake `switchboard` on PATH returns whatever the
test needs.
"""
import json, os, stat, subprocess, sys, tempfile, unittest

HOOKS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HOOKS)

def run_hook(name, command, env=None, fake_status=None):
    """Run hooks/<name> with a Bash tool call for `command`. Returns (code, stdout, stderr)."""
    e = dict(os.environ)
    e["CLAUDE_PLUGIN_ROOT"] = ROOT
    for k in ("POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED", "POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS"):
        e.pop(k, None)
    if env:
        e.update(env)
    tmp = None
    if fake_status is not None:
        tmp = tempfile.mkdtemp()
        fake = os.path.join(tmp, "switchboard")
        status_file = os.path.join(tmp, "status.json")
        with open(status_file, "w") as f:
            json.dump(fake_status, f)
        with open(fake, "w") as f:
            f.write("#!/bin/sh\n")
            f.write(f"case \"$*\" in *'auth status'*) cat '{status_file}' ;; *) exit 1 ;; esac\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        e["PATH"] = tmp + os.pathsep + e.get("PATH", "")
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    r = subprocess.run([sys.executable, os.path.join(HOOKS, name)], input=payload, capture_output=True, text=True, env=e, timeout=30)
    return r.returncode, r.stdout, r.stderr


class ArticulationHook(unittest.TestCase):
    HOOK = "pre-link-articulation.py"
    GOOD = "switchboard docs link a b -t BUILDS_ON --reason \"B extends A's cache claim to every read model\" --confidence established"

    def test_lets_unrelated_commands_through(self):
        for cmd in ("ls -la", "switchboard docs get a --state", "switchboard query '{ knowledgeGraphStats(driveId:\"x\"){ edgeCount } }'"):
            code, _, _ = run_hook(self.HOOK, cmd)
            self.assertEqual(code, 0, cmd)

    def test_blocks_a_bare_knowledge_link(self):
        code, _, err = run_hook(self.HOOK, "switchboard docs link a b -t BUILDS_ON")
        self.assertEqual(code, 2)
        self.assertIn("no --reason given", err)
        self.assertIn("--reason", err)
        # RELATES_TO is the default type and is a knowledge type too.
        code, _, err = run_hook(self.HOOK, "switchboard docs link a b")
        self.assertEqual(code, 2)
        self.assertIn("RELATES_TO", err)

    def test_rejects_placeholder_and_too_short_reasons(self):
        for reason in ("because", "BUILDS_ON", "tbd", "   ", "short one"):
            code, _, err = run_hook(self.HOOK, f"switchboard docs link a b -t RELATES_TO --reason '{reason}'")
            self.assertEqual(code, 2, reason)
        code, _, err = run_hook(self.HOOK, "switchboard docs link a b -t RELATES_TO -r 'x'")
        self.assertEqual(code, 2)
        self.assertIn("too short", err)

    def test_accepts_a_real_reason_in_either_flag_form(self):
        self.assertEqual(run_hook(self.HOOK, self.GOOD)[0], 0)
        self.assertEqual(run_hook(self.HOOK, "switchboard docs link a b -t CONTRADICTS -r 'A says X is required while B shows X is optional'")[0], 0)
        self.assertEqual(run_hook(self.HOOK, "switchboard docs link a b --type=SUPERSEDES --reason='newer measurement replaces the 2025 figure'")[0], 0)

    def test_navigation_edges_may_stay_bare(self):
        for t in ("CORE_IDEA", "CHILD_MOC"):
            self.assertEqual(run_hook(self.HOOK, f"switchboard docs link moc note -t {t}")[0], 0, t)

    def test_annotate_needs_a_real_reason_too(self):
        self.assertEqual(run_hook(self.HOOK, "switchboard docs annotate a b -t RELATES_TO --reason 'todo'")[0], 2)
        self.assertEqual(run_hook(self.HOOK, "switchboard docs annotate a b -t RELATES_TO --reason 'B is the worked example of the rule A states'")[0], 0)

    def test_sees_through_env_prefixes_profiles_and_chains(self):
        cmd = "export SWITCHBOARD_APP_NAME=x; cd /tmp && switchboard -p prod docs link a b -t BUILDS_ON"
        self.assertEqual(run_hook(self.HOOK, cmd)[0], 2)
        cmd = "switchboard docs link m n -t CORE_IDEA && switchboard docs link a b -t RELATES_TO"
        code, _, err = run_hook(self.HOOK, cmd)
        self.assertEqual(code, 2)
        self.assertNotIn("CORE_IDEA", err.split("\n\n")[1])

    def test_escape_hatch_for_bulk_imports(self):
        env = {"POWERHOUSE_KNOWLEDGE_ALLOW_BARE_LINKS": "1"}
        self.assertEqual(run_hook(self.HOOK, "switchboard docs link a b -t RELATES_TO", env=env)[0], 0)
        # The hatch allows ABSENT reasons, not bad ones.
        self.assertEqual(run_hook(self.HOOK, "switchboard docs link a b -t RELATES_TO --reason tbd", env=env)[0], 2)


class IdentityHook(unittest.TestCase):
    HOOK = "pre-write-identity.py"
    SIGNING = {"signing": True, "app_name": "switchboard-cli", "did": "did:key:zDna", "address": "0xabc", "profile": "local"}
    UNSIGNED = {"signing": False, "profile": "local"}

    def test_ignores_reads(self):
        code, out, _ = run_hook(self.HOOK, "switchboard docs get a --state", fake_status=self.SIGNING)
        self.assertEqual(code, 0)
        self.assertEqual(out, "")

    def test_labels_signed_writes_without_touching_permissions(self):
        for cmd in ("switchboard docs apply a --file f.json", "switchboard docs link a b -t RELATES_TO --reason 'x y z long enough reason here'",
                    "switchboard docs annotate a b -t RELATES_TO --reason 'x y z long enough reason here'", "FOO=1 switchboard -p local docs mutate a --op setTitle --input '{}'"):
            code, out, _ = run_hook(self.HOOK, cmd, fake_status=self.SIGNING)
            self.assertEqual(code, 0, cmd)
            j = json.loads(out)
            updated = j["hookSpecificOutput"]["updatedInput"]["command"]
            self.assertTrue(updated.startswith("export SWITCHBOARD_APP_NAME=powerhouse-knowledge; "), updated)
            self.assertNotIn("permissionDecision", out)

    def test_blocks_unsigned_writes_with_the_fix(self):
        code, _, err = run_hook(self.HOOK, "switchboard docs apply a --file f.json", fake_status=self.UNSIGNED)
        self.assertEqual(code, 2)
        self.assertIn("auth login --renown", err)

    def test_blocks_old_cli_and_broken_identity(self):
        code, _, err = run_hook(self.HOOK, "switchboard docs apply a --file f.json", fake_status={"profile": "local"})
        self.assertEqual(code, 2)
        self.assertIn("1.0.34", err)
        code, _, err = run_hook(self.HOOK, "switchboard docs apply a --file f.json", fake_status={"signing": False, "identity_error": "keypair missing"})
        self.assertEqual(code, 2)
        self.assertIn("keypair missing", err)

    def test_steers_raw_relationship_mutations_to_docs_link(self):
        cmd = "switchboard query 'mutation { addRelationship(sourceIdentifier:\"a\", targetIdentifier:\"b\", relationshipType:\"RELATES_TO\", branch:\"main\"){ documentType } }'"
        code, _, err = run_hook(self.HOOK, cmd, fake_status=self.SIGNING)
        self.assertEqual(code, 2)
        self.assertIn("docs link", err)

    def test_escape_hatch_lets_unsigned_through_still_labelled(self):
        code, out, _ = run_hook(self.HOOK, "switchboard docs apply a --file f.json", env={"POWERHOUSE_KNOWLEDGE_ALLOW_UNSIGNED": "1"}, fake_status=self.UNSIGNED)
        self.assertEqual(code, 0)
        self.assertEqual(out, "")  # unsigned path returns before labelling


class LintHook(unittest.TestCase):
    HOOK = "pre-apply-lint.py"

    def test_blocks_an_overlong_description_even_behind_global_options(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump([{"type": "SET_DESCRIPTION", "scope": "global", "input": {"description": "x" * 201, "updatedAt": "2026-09-02T00:00:00.000Z"}}], f)
        try:
            code, _, err = run_hook(self.HOOK, f"switchboard -p local docs apply abc --file {f.name}")
            self.assertEqual(code, 2)
            self.assertIn("BLOCKED", err)
        finally:
            os.unlink(f.name)

    def test_lets_a_valid_batch_through(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump([{"type": "SET_TITLE", "scope": "global", "input": {"title": "A claim", "updatedAt": "2026-09-02T00:00:00.000Z"}}], f)
        try:
            self.assertEqual(run_hook(self.HOOK, f"switchboard docs apply abc --file {f.name}")[0], 0)
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main(verbosity=1)
