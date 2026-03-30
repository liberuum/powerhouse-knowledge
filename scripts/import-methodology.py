#!/usr/bin/env python3
"""Import Ars Contexta methodology (249 research claims) into a Knowledge Vault via Switchboard CLI."""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
METHODOLOGY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "methodology")
SW = os.environ.get("SWITCHBOARD_BIN", "switchboard")


def run_sw(*args, timeout=60, retries=2):
    """Run a switchboard CLI command and return parsed JSON or raw output."""
    cmd = [SW] + list(args)
    for attempt in range(retries + 1):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode != 0:
                if attempt < retries and ("timeout" in result.stderr.lower() or "connection" in result.stderr.lower()):
                    time.sleep(2 * (attempt + 1))
                    continue
                return None, result.stderr
            try:
                return json.loads(result.stdout), None
            except json.JSONDecodeError:
                return result.stdout.strip(), None
        except subprocess.TimeoutExpired:
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
                continue
            return None, "Command timed out"
    return None, "All retries exhausted"


def run_sw_raw(*args, timeout=30):
    """Run a switchboard CLI command and return raw stdout."""
    cmd = [SW] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result.stdout, result.stderr, result.returncode


def parse_methodology_file(filepath):
    """Parse a methodology markdown file into structured data."""
    with open(filepath, "r") as f:
        content = f.read()

    # Split YAML frontmatter from body (no pyyaml dependency)
    parts = content.split("---")
    if len(parts) < 3:
        return None

    fm_text = parts[1]
    frontmatter = {}
    for line in fm_text.strip().split("\n"):
        m = re.match(r'^(\w+):\s*(.+)$', line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            # Parse arrays like ["a", "b"] or [a, b]
            if val.startswith("["):
                items = re.findall(r'"([^"]+)"|\'([^\']+)\'|\[\[([^\]]+)\]\]|(\w[\w\s-]+)', val)
                frontmatter[key] = [next(g for g in groups if g) for groups in items]
            elif val.startswith('"') and val.endswith('"'):
                frontmatter[key] = val.strip('"')
            elif val.startswith("'") and val.endswith("'"):
                frontmatter[key] = val.strip("'")
            elif val.startswith("[[") and val.endswith("]]"):
                frontmatter[key] = val[2:-2]
            else:
                frontmatter[key] = val
    body = "---".join(parts[2:]).strip()

    # Extract title from filename
    title = os.path.basename(filepath).replace(".md", "")

    # Split body into content and relevant notes
    body_content = body
    connections = []

    # Find "Relevant Notes:" section
    rn_match = re.search(r"\n(?:Relevant Notes|---)\s*\n", body)
    if rn_match:
        body_content = body[: rn_match.start()].strip()
        notes_section = body[rn_match.end() :]

        # Parse connection lines: - [[target]] — context
        for line in notes_section.split("\n"):
            m = re.match(
                r"^-\s+\[\[(.+?)\]\]\s*[—–-]\s*(.+)$", line.strip()
            )
            if m:
                connections.append(
                    {"target": m.group(1).strip(), "context": m.group(2).strip()}
                )

    # Remove the # Title line from content if it matches the filename
    lines = body_content.split("\n")
    if lines and lines[0].startswith("# "):
        body_content = "\n".join(lines[1:]).strip()

    # Extract topics from frontmatter
    topics = []
    if frontmatter.get("topics"):
        for t in frontmatter["topics"]:
            # Remove [[]] wrappers
            clean = re.sub(r"\[\[|\]\]", "", str(t)).strip()
            if clean:
                topics.append(clean)

    # Extract methodology
    methodology = frontmatter.get("methodology", [])
    if isinstance(methodology, str):
        methodology = [methodology]

    # Extract sources
    sources = []
    src = frontmatter.get("source", "")
    if src:
        clean_src = re.sub(r"\[\[|\]\]", "", str(src)).strip()
        if clean_src:
            sources.append(clean_src)

    return {
        "title": title,
        "description": frontmatter.get("description", ""),
        "content": body_content,
        "kind": frontmatter.get("kind", "research"),
        "methodology": methodology,
        "sources": sources,
        "topics": topics,
        "connections": connections,
    }


def main():
    drive = sys.argv[1] if len(sys.argv) > 1 else "knowledge-vault"

    # Get drive info and research folder
    tree_data, err = run_sw("docs", "tree", drive, "--format", "json")
    if not tree_data or isinstance(tree_data, str):
        print(f"Error reading drive: {err}")
        sys.exit(1)

    research_folder = None
    for node in tree_data.get("nodes", []):
        if node.get("name") == "research" and node.get("kind") == "folder":
            if not node.get("parentFolder"):
                research_folder = node["id"]
                break

    if not research_folder:
        print("Error: /research/ folder not found in drive")
        sys.exit(1)

    drive_id = tree_data["id"]
    print(f"Drive: {tree_data['name']} ({drive_id})")
    print(f"Research folder: {research_folder}")

    # Check existing claims
    existing = sum(
        1
        for n in tree_data.get("nodes", [])
        if n.get("documentType") == "bai/research-claim"
    )
    if existing >= 200:
        print(f"Methodology already imported ({existing} claims). Skipping.")
        sys.exit(0)

    # Build existing title set for skip-if-exists
    existing_titles = {
        n["name"]
        for n in tree_data.get("nodes", [])
        if n.get("documentType") == "bai/research-claim"
    }
    existing_id_map = {
        n["name"]: n["id"]
        for n in tree_data.get("nodes", [])
        if n.get("documentType") == "bai/research-claim"
    }

    # Parse all methodology files
    all_files = sorted([f for f in os.listdir(METHODOLOGY_DIR) if f.endswith(".md")])

    print(f"\nParsing {len(all_files)} methodology files...")
    claims = {}
    for filename in all_files:
        filepath = os.path.join(METHODOLOGY_DIR, filename)
        parsed = parse_methodology_file(filepath)
        if parsed:
            claims[parsed["title"]] = parsed

    print(f"Parsed {len(claims)} claims")

    # PASS 1: Create all claim documents (skips existing)
    print(f"\n{'='*60}")
    print(f"PASS 1: Creating research claim documents ({len(existing_titles)} already exist)")
    print(f"{'='*60}")

    title_to_id = dict(existing_id_map)  # Seed with existing docs
    created = 0
    skipped = 0
    failed = 0

    for i, (title, claim) in enumerate(claims.items()):
        # Skip if already exists in drive
        if title in existing_titles:
            skipped += 1
            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(claims)}] {created} created, {skipped} skipped, {failed} failed")
            continue

        # Create the document
        data, err = run_sw(
            "docs",
            "create",
            "--type",
            "bai/research-claim",
            "--name",
            title,  # Full title — truncation breaks wiki link resolution in pass 2
            "--drive",
            drive,
            "--parent-folder",
            research_folder,
            "--format",
            "json",
        )

        if data and isinstance(data, dict) and data.get("id"):
            doc_id = data["id"]
            title_to_id[title] = doc_id

            # Populate with CREATE_CLAIM
            claim_input = json.dumps(
                {
                    "title": claim["title"],
                    "description": claim["description"][:500] if claim["description"] else "Research claim",
                    "content": claim["content"],
                    "kind": claim["kind"],
                    "methodology": claim["methodology"],
                    "sources": claim["sources"],
                    "topics": claim["topics"],
                }
            )

            _, err2 = run_sw(
                "docs",
                "mutate",
                doc_id,
                "--op",
                "createClaim",
                "--input",
                claim_input,
                "--format",
                "json",
            )
            if err2 and "Error" in err2:
                print(f"  [{i+1}/{len(claims)}] {title[:50]}... CREATE_CLAIM failed: {err2[:80]}")
                failed += 1
            else:
                created += 1
                if (i + 1) % 10 == 0:
                    print(f"  [{i+1}/{len(claims)}] {created} created, {skipped} skipped, {failed} failed")
        else:
            print(f"  [{i+1}/{len(claims)}] FAILED to create: {title[:50]}... {err}")
            failed += 1

        # Delay to avoid overwhelming the reactor (longer for remote)
        time.sleep(0.3)

    print(f"\nPass 1 complete: {created} created, {failed} failed")
    print(f"Title→ID map: {len(title_to_id)} entries")

    # PASS 2: Resolve connections
    print(f"\n{'='*60}")
    print(f"PASS 2: Resolving connections")
    print(f"{'='*60}")

    resolved = 0
    unresolved = 0
    conn_errors = 0

    for i, (title, claim) in enumerate(claims.items()):
        if title not in title_to_id:
            continue
        source_id = title_to_id[title]

        for j, conn in enumerate(claim["connections"]):
            target_title = conn["target"]
            if target_title in title_to_id:
                target_id = title_to_id[target_title]
                # Use a deterministic hash of source+target+index for globally unique IDs
                conn_hash = hashlib.md5(f"{source_id}:{target_id}:{j}".encode()).hexdigest()[:16]
                conn_input = json.dumps(
                    {
                        "id": f"conn-{conn_hash}",
                        "targetRef": target_id,
                        "contextPhrase": conn["context"][:200],
                    }
                )
                _, err = run_sw(
                    "docs",
                    "mutate",
                    source_id,
                    "--op",
                    "addResearchConnection",
                    "--input",
                    conn_input,
                    "--format",
                    "json",
                )
                if err and "Error" in err:
                    conn_errors += 1
                else:
                    resolved += 1
            else:
                unresolved += 1

        if (i + 1) % 20 == 0:
            print(
                f"  [{i+1}/{len(claims)}] {resolved} resolved, {unresolved} unresolved, {conn_errors} errors"
            )

        # Delay to avoid overwhelming the reactor (longer for remote)
        time.sleep(0.2)

    print(f"\nPass 2 complete: {resolved} resolved, {unresolved} unresolved, {conn_errors} errors")

    print(f"\n{'='*60}")
    print(f"METHODOLOGY IMPORT COMPLETE")
    print(f"{'='*60}")
    print(f"Claims created: {created}")
    print(f"Connections resolved: {resolved}")
    print(f"Connections unresolved: {unresolved}")
    print(f"Errors: {failed + conn_errors}")


if __name__ == "__main__":
    main()
