#!/usr/bin/env node
import { resolve } from "node:path";
import { render } from "ink";
import { App } from "./App.tsx";

const cwd = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

const app = render(<App cwd={cwd} />, { exitOnCtrlC: true });
await app.waitUntilExit();
