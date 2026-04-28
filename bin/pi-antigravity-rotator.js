#!/usr/bin/env node
import("tsx/esm/api").then(({ register }) => {
	register();
	return import("../src/cli.ts");
});
