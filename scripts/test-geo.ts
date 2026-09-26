/** Verifies the geo/ASN lookup against a real public IP (not localhost). */
import "dotenv/config";
import { lookupGeo } from "../src/mastra/enrich";

const ip = process.argv[2] ?? "8.8.8.8";
const { geo, warnings } = await lookupGeo(ip);
console.log(`ip=${ip}`);
console.log("geo:", JSON.stringify(geo, null, 2));
console.log("warnings:", warnings);
