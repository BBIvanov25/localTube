import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const releaseDirectory = path.join(root, "release");
const executable = path.join(root, "src-tauri", "target", "release", "localtube.exe");
const installerDirectory = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const installerName = `LocalTube_${version}_x64-setup.exe`;
const installer = path.join(installerDirectory, installerName);
const availableInstallers = (await readdir(installerDirectory))
  .filter(name => name.toLowerCase().endsWith("-setup.exe"));

if (!(await stat(executable)).isFile()) {
  throw new Error(`Portable application executable was not found: ${executable}`);
}

if (!availableInstallers.includes(installerName)) {
  throw new Error(`Expected ${installerName} in ${installerDirectory}; found: ${availableInstallers.join(", ") || "none"}.`);
}

if (!(await stat(installer)).isFile()) {
  throw new Error(`NSIS setup executable is not a file: ${installer}`);
}

await mkdir(releaseDirectory, { recursive: true });
await copyFile(executable, path.join(releaseDirectory, "LocalTube-Portable.exe"));
await copyFile(installer, path.join(releaseDirectory, installerName));

console.log(`Windows installer and portable executable copied to ${releaseDirectory}`);
