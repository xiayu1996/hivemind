import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

/** Suffix of a file that has been packed; the plain file is gone when it exists. */
export const PACKED_SUFFIX = ".zst";

/**
 * A window wide enough to reach the previous copy of the conversation.
 *
 * Every provider request in these files carries the whole conversation that
 * came before it, so a file is mostly one text repeated at growing lengths.
 * The redundancy spans megabytes, far past a deflate window: gzip gets under
 * 4x on a real log where this gets past 200x, and the difference is a 139MB
 * file becoming 690KB rather than 36MB.
 */
const WINDOW_LOG = 27;

/** Refuses a file that would not fit in memory rather than truncating it. */
const MAX_UNPACKED_BYTES = 1_024 * 1_024 * 1_024;

/**
 * Packs a finished file and removes the plain one.
 *
 * Only ever called once its writer has stopped: these files are appended line
 * by line and a packed file cannot be appended to, so packing one still being
 * written would lose everything after it.
 */
export async function packFile(path: string): Promise<void> {
  const packed = await compress(await readFile(path), {
    params: {
      [constants.ZSTD_c_compressionLevel]: 3,
      [constants.ZSTD_c_windowLog]: WINDOW_LOG,
      [constants.ZSTD_c_enableLongDistanceMatching]: 1,
    },
  });
  await writeFile(`${path}${PACKED_SUFFIX}`, packed);
  await rm(path, { force: true });
}

/**
 * Reads a file whether or not it has been packed; the caller names the plain
 * path either way.
 */
export async function readPackedText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
    // Packed, or genuinely absent -- the second is reported by the read below,
    // which names the path the caller asked for rather than one it never
    // mentioned.
    const packed = await readFile(`${path}${PACKED_SUFFIX}`).catch(() => {
      throw cause;
    });
    const unpacked = await decompress(packed, {
      maxOutputLength: MAX_UNPACKED_BYTES,
      params: { [constants.ZSTD_d_windowLogMax]: WINDOW_LOG },
    });
    return unpacked.toString("utf8");
  }
}
