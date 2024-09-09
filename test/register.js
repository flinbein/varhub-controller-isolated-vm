// test/register.js
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import process, { setUncaughtExceptionCaptureCallback } from "node:process";

setUncaughtExceptionCaptureCallback((err) => {
	console.error("============ <UncaughtExceptionCaptureCallback>  ============");
	console.error(err);
	console.error("============ <UncaughtExceptionCaptureCallback/> ============");
	process.exit(1);
});
register("ts-node/esm", pathToFileURL("./"));
