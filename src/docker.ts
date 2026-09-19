/** Export one exact guest image and publish it with host-side registry credentials. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Connection } from "./lima.js";
import { fail, findExecutable, runChild } from "./system.js";

type PublishConnection = Pick<Connection, "capture" | "writeOutput">;
const imageSchema = z.object({
  Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  RepoTags: z.array(z.string()),
  Os: z.string().min(1),
  Architecture: z.string().min(1),
  Variant: z.string().optional(),
});

export function validateImageReference(reference: string): string {
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  if (
    reference.startsWith("-") ||
    /[\x00-\x20\x7f]/.test(reference) ||
    reference.includes("@") ||
    colon <= slash ||
    colon === reference.length - 1
  )
    fail("docker publish requires an image reference with an explicit tag");
  return reference;
}

function inspectImage(connection: PublishConnection, reference: string) {
  let image: z.infer<typeof imageSchema>;
  try {
    image = imageSchema.parse(
      JSON.parse(
        connection.capture([
          "docker",
          "image",
          "inspect",
          "--format",
          "{{json .}}",
          reference,
        ]),
      ),
    );
  } catch {
    fail(
      `guest image does not exist or Docker cannot inspect it: ${reference}`,
    );
  }
  if (!image.RepoTags.includes(reference))
    fail(`guest image is not tagged exactly as ${reference}`);
  return image;
}

export async function publishImage(
  connection: PublishConnection,
  requestedReference: string,
  hostEnvironment = process.env,
): Promise<number> {
  const reference = validateImageReference(requestedReference);
  const crane =
    findExecutable("crane", hostEnvironment.PATH) ??
    fail(
      "crane is required on the host to publish images; install it with `brew install crane` or see https://github.com/google/go-containerregistry/tree/main/cmd/crane",
    );
  const image = inspectImage(connection, reference);
  const platform = `${image.Os}/${image.Architecture}${image.Variant ? `/${image.Variant}` : ""}`;
  const directory = mkdtempSync(join(tmpdir(), "agentbox-image-"));
  const archive = join(directory, "image.tar");
  try {
    console.error(
      `agentbox: exporting ${reference} (${platform}, ${image.Id})`,
    );
    const exported = await connection.writeOutput(
      ["docker", "image", "save", image.Id],
      archive,
    );
    if (exported !== 0) {
      console.error(`agentbox: guest image export failed for ${reference}`);
      return exported;
    }
    console.error(
      `agentbox: publishing ${reference} with host registry credentials`,
    );
    const published = await runChild(crane, ["push", archive, reference], {
      env: hostEnvironment,
      stdio: "inherit",
    });
    if (published !== 0)
      console.error(
        `agentbox: host registry publish failed for ${reference}; check host registry authentication and permissions`,
      );
    return published;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
