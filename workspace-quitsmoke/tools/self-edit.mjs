#!/usr/bin/env node
// THIN SHIM → shared/bin/self-edit.mjs (agentId "zorro"). The unified engine + per-agent guardedJson
// /coreTool live in shared/lib/self-edit.mjs; shared/registry.json supplies workspaceDir. Test
// discovery covers BOTH tools/*.test.mjs and tools/lib/*.test.mjs, so each bot's safety net is intact.
// (self-edit.test.mjs, where present, drives this as a CLI subprocess — that contract is preserved.)
import { runForAgent } from '../../shared/bin/self-edit.mjs';
runForAgent('zorro');
