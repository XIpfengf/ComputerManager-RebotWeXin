import assert from "node:assert/strict";
import test from "node:test";

import {
  desktopNotificationCandidateClientIds,
  desktopNotificationClientId,
  desktopNotificationMessageClientIds,
  parseDesktopNotificationClientId,
  terminalNotificationClientId,
} from "../src/bridge/desktop-notification-identity.ts";
test("Desktop notification identities support arbitrary positive part numbers", () => {
  const base = desktopNotificationClientId("thread-a", "turn-a");
  assert.equal(desktopNotificationMessageClientIds(base, 25).length, 25);
  assert.equal(parseDesktopNotificationClientId(`${base}:part:25`)?.part, 25);
  assert.equal(parseDesktopNotificationClientId(`${base}:part:0`), null);
  assert.equal(parseDesktopNotificationClientId(`${base}:part:9007199254740992`), null);
});

test("interrupted Desktop notifications are grouped but cannot open a reply route", () => {
  const clientId = desktopNotificationClientId(
    "thread-interrupted",
    "turn-interrupted",
    false,
  );

  assert.deepEqual(parseDesktopNotificationClientId(clientId), {
    baseClientId: clientId,
    origin: "desktop",
    part: null,
    replyable: false,
    threadId: "thread-interrupted",
    turnId: "turn-interrupted",
  });
});

test("automation notifications use a distinct durable identity", () => {
  const clientId = terminalNotificationClientId(
    "automation",
    "thread-automation",
    "turn-automation",
  );

  assert.equal(
    clientId,
    "codex-ilink:automation:thread-automation:turn-automation:final",
  );
  assert.deepEqual(parseDesktopNotificationClientId(clientId), {
    baseClientId: clientId,
    origin: "automation",
    part: null,
    replyable: true,
    threadId: "thread-automation",
    turnId: "turn-automation",
  });
});
