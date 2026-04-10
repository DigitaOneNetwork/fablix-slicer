import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs/promises";
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import path from "path";
import AdmZip from "adm-zip";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json());

const UPLOADS_DIR = path.join(process.cwd(), "tmp_uploads");
const OUTPUT_DIR = path.join(process.cwd(), "tmp_output");

const upload = multer({ dest: UPLOADS_DIR });

const ORCA_BIN = process.env.ORCA_CLI_PATH;
const PROFILES_BASE = process.env.ORCA_PROFILES_PATH;
const BUILD_COMMIT = process.env.SLICER_BUILD_COMMIT ?? "unknown";
const BUILD_DATE = process.env.SLICER_BUILD_DATE ?? "unknown";

// Liest LOCALE_ARCHIVE aus Env, oder sucht mit kurzem Timeout
function findLocaleArchive() {
  if (process.env.LOCALE_ARCHIVE) return process.env.LOCALE_ARCHIVE;
  try {
    const result = execSync(
      "find /nix/store -maxdepth 2 -name 'locale-archive' 2>/dev/null | head -1",
      { timeout: 5000 }
    ).toString().trim();
    return result || null;
  } catch (_) {}
  return null;
}

const LOCALE_ARCHIVE = findLocaleArchive();
console.log(`[SLICER] LOCALE_ARCHIVE: ${LOCALE_ARCHIVE ?? "nicht gefunden"}`);

// Mappt API-Material auf Bambu-Filament-Profilname
function getFilamentProfile(material) {
  const map = {
    pla:    "Bambu PLA Basic @BBL X1C",
    petg:   "Bambu PETG Basic @BBL X1C",
    abs:    "Bambu ABS @BBL X1C",
    tpu:    "Bambu TPU 95A @BBL X1C",
    "pla-cf": "Bambu PLA-CF @BBL X1C",
    "petg-cf": "Generic PETG-CF @BBL X1C",
  };
  return map[material?.toLowerCase()] ?? "Bambu PLA Basic @BBL X1C";
}

// Mappt API-Qualität auf Prozess-Profilname
function getProcessProfile(quality) {
  return quality === "fine"
    ? "0.20mm Standard @BBL X1C"
    : "0.28mm Extra Draft @BBL X1C";
}

// Parst Druckzeit aus G-Code-Kommentar:
// "; estimated printing time (normal mode) = 1h 2m 30s"
function parsePrintTimeSeconds(gcode) {
  const match =
    gcode.match(/;\s*estimated printing time \(normal mode\)\s*=\s*(.*)/i) ??
    gcode.match(/;\s*total estimated time:\s*(.*)/i);
  if (!match) return null;

  const timeStr = match[1].trim();
  let seconds = 0;
  const d = timeStr.match(/(\d+)d/);
  const h = timeStr.match(/(\d+)h/);
  const m = timeStr.match(/(\d+)m/);
  const s = timeStr.match(/(\d+)s/);
  if (d) seconds += parseInt(d[1]) * 86400;
  if (h) seconds += parseInt(h[1]) * 3600;
  if (m) seconds += parseInt(m[1]) * 60;
  if (s) seconds += parseInt(s[1]);
  return seconds > 0 ? seconds : null;
}

// Parst Filamentgewicht aus G-Code-Kommentar:
// "; filament used [g] = 42.50" oder "; total filament used [g] = 42.50"
function parseFilamentGrams(gcode) {
  const match =
    gcode.match(/;\s*(?:total\s+)?filament\s+used\s*\[g\]\s*[:=]\s*([\d.]+)/i) ??
    gcode.match(/;\s*(?:total\s+)?filament\s+weight\s*\[g\]\s*[:=]\s*([\d.]+)/i);
  return match ? parseFloat(match[1]) : null;
}

function getMetadataDebugLines(gcode) {
  return gcode
    .split(/\r?\n/)
    .filter((line) => /filament|estimated|time|weight|used/i.test(line))
    .slice(0, 80)
    .join("\n");
}

// Extrahiert G-Code-Text aus einer .gcode.3mf Datei (ZIP)
function extractGcodeFromThreeMF(threeMFPath) {
  const zip = new AdmZip(threeMFPath);
  const entries = zip.getEntries();

  const gcodeEntry = entries.find((e) => e.entryName.endsWith(".gcode"));

  if (!gcodeEntry) throw new Error("Kein G-Code in 3MF-Datei gefunden.");
  return zip.readAsText(gcodeEntry);
}

async function readGeneratedGcode(jobOutputDir) {
  const outFiles = await fs.readdir(jobOutputDir);
  const gcodeFile = outFiles.find((f) => f.toLowerCase().endsWith(".gcode"));

  if (gcodeFile) {
    return {
      gcode: await fs.readFile(path.join(jobOutputDir, gcodeFile), "utf8"),
      outFiles,
    };
  }

  const threeMFFile = outFiles.find((f) => f.toLowerCase().endsWith(".3mf"));

  if (threeMFFile) {
    return {
      gcode: extractGcodeFromThreeMF(path.join(jobOutputDir, threeMFFile)),
      outFiles,
    };
  }

  let resultJson = "";
  try {
    resultJson = await fs.readFile(path.join(jobOutputDir, "result.json"), "utf8");
  } catch (_) {}

  const fileList = outFiles.length ? outFiles.join(", ") : "keine";
  throw new Error(
    `OrcaSlicer hat keine G-Code-Datei erzeugt. Ausgabedateien: ${fileList}` +
      (resultJson ? `. result.json: ${resultJson}` : "")
  );
}

app.post(["/api/slice", "/slice"], upload.single("stl"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Keine STL-Datei hochgeladen." });
  }

  if (!ORCA_BIN) {
    return res.status(500).json({ error: "ORCA_CLI_PATH ist nicht konfiguriert." });
  }

  // Datei mit .stl Extension umbenennen, damit OrcaSlicer das Format erkennt
  const stlPath = path.resolve(req.file.path) + ".stl";
  await fs.rename(req.file.path, stlPath);
  const material = req.body.material ?? "pla";
  const quality  = req.body.quality  ?? "standard";
  const jobId    = `job_${Date.now()}`;
  const jobOutputDir = path.join(OUTPUT_DIR, jobId);

  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.mkdir(jobOutputDir, { recursive: true });

    const machineProfPath = path.join(PROFILES_BASE, "machine", "Bambu Lab X1 Carbon 0.4 nozzle.json");
    const processProfName = getProcessProfile(quality);
    const processProfPath = path.join(PROFILES_BASE, "process", `${processProfName}.json`);
    const filamentProfName = getFilamentProfile(material);
    const filamentProfPath = path.join(PROFILES_BASE, "filament", `${filamentProfName}.json`);

    // Patched Prozess-Profil: liest Originaldatei und setzt use_relative_e_distances=0
    // (verhindert OrcaSlicer exit code -51 durch fdm_machine_common Basis-Profil)
    const patchedProcPath = path.join(jobOutputDir, "process_patched.json");
    const procRaw = JSON.parse(await fs.readFile(processProfPath, "utf8"));
    procRaw.use_relative_e_distances = "0";
    await fs.writeFile(patchedProcPath, JSON.stringify(procRaw));

    console.log(`[SLICER] Job ${jobId}: ${req.file.originalname}`);
    console.log(`[SLICER] Drucker:   Bambu Lab X1 Carbon 0.4 nozzle`);
    console.log(`[SLICER] Prozess:   ${processProfName}`);
    console.log(`[SLICER] Filament:  ${filamentProfName}`);

    const env = {
      ...process.env,
      LC_ALL: "C.UTF-8",
      ...(LOCALE_ARCHIVE ? { LOCALE_ARCHIVE } : {}),
    };

    const xvfbRun = process.env.XVFB_RUN ?? "xvfb-run";

    // OrcaSlicer CLI via xvfb-run (headless)
    await execFileAsync(
      xvfbRun,
      [
        "-a",
        ORCA_BIN,
        "--slice", "0",
        "--load-settings", `${machineProfPath};${patchedProcPath}`,
        "--load-filaments", filamentProfPath,
        "--allow-newer-file",
        "--outputdir", jobOutputDir,
        stlPath,
      ],
      { env, timeout: 120_000 }
    );

    const { gcode, outFiles } = await readGeneratedGcode(jobOutputDir);

    const printTimeSeconds = parsePrintTimeSeconds(gcode);
    const filamentGrams    = parseFilamentGrams(gcode);

    if (printTimeSeconds === null || filamentGrams === null) {
      const metadataDebug = getMetadataDebugLines(gcode);
      throw new Error(
        `Konnte Druckzeit oder Filamentgewicht aus G-Code nicht lesen. Ausgabedateien: ${outFiles.join(", ")}` +
          (metadataDebug ? `. Metadata-Zeilen: ${metadataDebug}` : "")
      );
    }

    console.log(`[SLICER] Ergebnis: ${filamentGrams}g, ${Math.round(printTimeSeconds / 60)} min`);

    res.json({
      success: true,
      filamentGrams,
      printTimeSeconds,
    });

  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? "";
    const stdout = error.stdout?.toString?.() ?? "";
    console.error(`[SLICER] Fehler:`, error.message);
    if (stderr) console.error(`[SLICER] stderr:`, stderr);
    if (stdout) console.error(`[SLICER] stdout:`, stdout);
    res.status(500).json({ error: "Slicing fehlgeschlagen.", details: error.message, stderr, stdout });
  } finally {
    // Aufräumen
    try { await fs.unlink(stlPath); } catch (_) {}
    try { await fs.rm(jobOutputDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.get(["/", "/health", "/version"], (_req, res) => {
  res.json({
    status: "ok",
    method: "orca-slicer-cli",
    orca: ORCA_BIN ?? "nicht konfiguriert",
    build: {
      commit: BUILD_COMMIT,
      date: BUILD_DATE,
    },
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[SLICER] Service läuft auf Port ${PORT}`);
  console.log(`[SLICER] OrcaSlicer: ${ORCA_BIN}`);
});
