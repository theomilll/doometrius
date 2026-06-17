# Two-browser co-op verification against the running dev stack (vite:5173 + ws:8787).
import json
import time
from playwright.sync_api import sync_playwright

import os
URL = os.environ.get("TEST_URL", "http://localhost:5173")
failures = []


def check(label, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(label)


def debug(page):
    return page.evaluate("() => window.__frontierMultiplayer || null")


def wait_until(fn, label, timeout=15):
    start = time.time()
    while time.time() - start < timeout:
        if fn():
            return True
        time.sleep(0.1)
    check(label, False, "timeout")
    return False


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx1 = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx2 = browser.new_context(viewport={"width": 1280, "height": 800})
    p1, p2 = ctx1.new_page(), ctx2.new_page()
    errors1, errors2 = [], []
    p1.on("pageerror", lambda e: errors1.append(str(e)))
    p2.on("pageerror", lambda e: errors2.append(str(e)))
    p1.on("console", lambda m: errors1.append(m.text) if m.type == "error" else None)
    p2.on("console", lambda m: errors2.append(m.text) if m.type == "error" else None)

    p1.goto(URL)
    p2.goto(URL)
    p1.wait_for_load_state("networkidle")
    p2.wait_for_load_state("networkidle")

    wait_until(lambda: debug(p1) and debug(p1)["state"], "P1 receives snapshots")
    wait_until(lambda: debug(p2) and debug(p2)["state"], "P2 receives snapshots")
    d1, d2 = debug(p1), debug(p2)
    check("distinct player slots", {d1["playerId"], d2["playerId"]} == {"p1", "p2"},
          f"{d1['playerId']}/{d2['playerId']}")
    slot1, slot2 = d1["playerId"], d2["playerId"]

    # restart for a clean run
    p1.locator('button[aria-label="Restart mission"]').click()
    wait_until(lambda: debug(p1)["state"]["mode"] == "briefing", "briefing after restart")
    p1.screenshot(path="artifacts/qa-briefing.png")

    # start game: P2 fires (keyboard F)
    p2.locator("canvas").click(position={"x": 640, "y": 400})
    p2.keyboard.down("f")
    wait_until(lambda: debug(p1)["state"]["mode"] == "playing", "either player can start")
    p2.keyboard.up("f")
    check("mission started by P2", debug(p1)["state"]["mode"] == "playing")

    # both move simultaneously
    pos = {pid: dict(debug(p1)["state"]["players"][pid]["pos"]) for pid in ("p1", "p2")}
    p1.locator("canvas").click(position={"x": 640, "y": 400})
    p1.keyboard.down("w")
    p2.keyboard.down("w")
    time.sleep(1.0)
    p1.keyboard.up("w")
    p2.keyboard.up("w")
    state = debug(p1)["state"]
    moved = {pid: ((state["players"][pid]["pos"]["x"] - pos[pid]["x"]) ** 2
                   + (state["players"][pid]["pos"]["y"] - pos[pid]["y"]) ** 2) ** 0.5
             for pid in ("p1", "p2")}
    check("co-op: both moved at once", moved["p1"] > 0.5 and moved["p2"] > 0.5,
          f"p1={moved['p1']:.2f} p2={moved['p2']:.2f}")

    # prediction sanity: predicted pos tracks server pos closely after settling
    p1.keyboard.down("w")
    time.sleep(0.8)
    d = debug(p1)
    p1.keyboard.up("w")
    if d["predictedPos"] and d["serverPos"]:
        err = ((d["predictedPos"]["x"] - d["serverPos"]["x"]) ** 2
               + (d["predictedPos"]["y"] - d["serverPos"]["y"]) ** 2) ** 0.5
        # predicted leads server by ~RTT worth of movement; just bound it
        check("prediction error bounded", err < 0.6, f"{err:.3f}")
        check("pending inputs small", d["pendingCount"] < 12, str(d["pendingCount"]))
    else:
        check("prediction active", False, json.dumps({k: d[k] for k in ('predictedPos', 'serverPos')}))

    check("interp buffer populated", debug(p1)["interpBufferLen"] >= 2, str(debug(p1)["interpBufferLen"]))
    bps = debug(p1)["bytesPerSecond"]
    check("bandwidth metered", bps > 0, f"{bps/1000:.1f}KB/s")

    # weapon switch via key 2
    p1.keyboard.press("2")
    wait_until(lambda: debug(p1)["state"]["players"][slot1]["weapon"] == "ribShotgun", "weapon switch key 2")
    check("weapon switch via key", debug(p1)["state"]["players"][slot1]["weapon"] == "ribShotgun")

    # fire a few shots for the screenshot, then capture
    p1.keyboard.down("f")
    time.sleep(0.6)
    p1.keyboard.up("f")
    time.sleep(0.3)
    p1.screenshot(path="artifacts/qa-ingame-p1.png")
    p2.screenshot(path="artifacts/qa-ingame-p2.png")

    # reconnect: reload P2's page, same slot via sessionStorage token
    p2.reload()
    p2.wait_for_load_state("networkidle")
    wait_until(lambda: debug(p2) and debug(p2)["playerId"] == slot2, "page2 re-claims slot after reload")
    check("reload re-claims same slot", (debug(p2) or {}).get("playerId") == slot2)

    interesting1 = [e for e in errors1 if "favicon" not in e]
    interesting2 = [e for e in errors2 if "favicon" not in e]
    check("no console errors P1", not interesting1, "; ".join(interesting1[:3]))
    check("no console errors P2", not interesting2, "; ".join(interesting2[:3]))

    browser.close()

print("\nALL PASS" if not failures else f"\nFAILURES: {failures}")
exit(0 if not failures else 1)
