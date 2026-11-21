import {ingest} from './lib.mjs';

// Builds the indexes from the knowledge folder: node ingest.mjs
const totals = await ingest((event) => console.log(JSON.stringify(event)));
console.log(`Indexed ${totals.docs} documents as ${totals.chunks} passages in ${totals.ms} ms.`);
