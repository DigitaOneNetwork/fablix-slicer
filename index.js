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
  const match = gcode.match(/;\s*estimated printing time \(normal mode\)\s*=\s*(.*)/i);
  if (!match) return null;

  const timeStr = match[1].trim();
  let seconds = 0;
  const h = timeStr.match(/(\d+)h/);
  const m = timeStr.match(/(\d+)m/);
  const s = timeStr.match(/(\d+)s/);
  if (h) seconds += parseInt(h[1]) * 3600;
  if (m) seconds += parseInt(m[1]) * 60;
  if (s) seconds += parseInt(s[1]);
  return seconds > 0 ? seconds : null;
}

// Parst Filamentgewicht aus G-Code-Kommentar:
// "; total filament used [g] = 42.50"
function parseFilamentGrams(gcode) {
  const match = gcode.match(/;\s*total filament used \[g\]\s*=\s*([\d.]+)/i);
  return match ? parseFloat(match[1]) : null;
}

// Extrahiert G-Code-Text aus einer .gcode.3mf Datei (ZIP)
function extractGcodeFromThreeMF(threeMFPath) {
  const zip = new AdmZip(threeMFPath);
  const entries = zip.getEntries();

  // Suche nach der Gcode-Datei im Metadata-Ordner
  const gcodeEntry = entries.find(
    (e) => e.entryName.startsWith("Metadata/") && e.entryName.endsWith(".gcode")
  );

  if (!gcodeEntry) throw new Error("Kein G-Code in 3MF-Datei gefunden.");
  return zip.readAsText(gcodeEntry);
}

app.post("/api/slice", upload.single("stl"), async (req, res) => {
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

    // Datadir = OrcaSlicer Ressourcen-Ordner, damit Profil-Vererbung aufgelöst wird
    const orcaResourcesDir = path.dirname(path.dirname(PROFILES_BASE)); // .../resources

    // OrcaSlicer CLI via xvfb-run (headless)
    await execFileAsync(
      xvfbRun,
      [
        "-a",
        ORCA_BIN,
        "--datadir", orcaResourcesDir,
        "--slice", "0",
        "--load-settings", `${machineProfPath};${processProfPath}`,
        "--load-filaments", filamentProfPath,
        "--outputdir", jobOutputDir,
        stlPath,
      ],
      { env, timeout: 120_000 }
    );

    // Finde die erzeugte .gcode.3mf Datei
    const outFiles = await fs.readdir(jobOutputDir);
    const threeMFFile = outFiles.find((f) => f.endsWith(".gcode.3mf"));
    if (!threeMFFile) throw new Error("OrcaSlicer hat keine .gcode.3mf-Datei erzeugt.");

    const threeMFPath = path.join(jobOutputDir, threeMFFile);
    const gcode = extractGcodeFromThreeMF(threeMFPath);

    const printTimeSeconds = parsePrintTimeSeconds(gcode);
    const filamentGrams    = parseFilamentGrams(gcode);

    if (printTimeSeconds === null || filamentGrams === null) {
      throw new Error("Konnte Druckzeit oder Filamentgewicht aus G-Code nicht lesen.");
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

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    method: "orca-slicer-cli",
    orca: ORCA_BIN ?? "nicht konfiguriert",
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[SLICER] Service läuft auf Port ${PORT}`);
  console.log(`[SLICER] OrcaSlicer: ${ORCA_BIN}`);
});
