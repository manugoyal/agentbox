import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// TypeScript does not remove outputs whose source files were deleted. Cleaning
// this exact generated directory keeps local/global installs and npm packs from
// carrying obsolete runtime modules.
rmSync(fileURLToPath(new URL("../dist", import.meta.url)), {
  recursive: true,
  force: true,
});
