// ─── The search/replace edit engine (extracted Phase 11, M63) ───────────────
//
// Moved out of `tools/tool-runner.ts` unchanged, because `tool-runner.ts` imports `vscode`
// and the headless executor needs exactly this function. Two copies of the algorithm that
// decides where an agent's edit lands is the worst possible thing to duplicate: they would
// drift, and the drift would be silent — one executor applying an edit the other refuses is
// a difference nobody sees until a CI run writes something a local run would not have.
//
// The behaviour is deliberately unchanged, including the parts that look strict:
//
//   * **A block that matches nothing throws.** The alternative is a partial application,
//     where blocks 1 and 3 land and block 2 does not, leaving a file in a state the model
//     never described. Refusing the whole edit keeps the file consistent with *some*
//     version the model intended.
//   * **A block that matches more than once throws.** The first match is not more likely to
//     be the right one than the second, and picking it silently is how an agent edits the
//     wrong `if (!user) return;` out of four.

const ORIGINAL_MARKER = '<<<<<<< ORIGINAL';
const DIVIDER_MARKER = '=======';
const UPDATED_MARKER = '>>>>>>> UPDATED';

export function applySearchReplace(fileContent: string, blocksStr: string): string {
    let content = fileContent;
    let startIndex = 0;
    let blockCount = 0;

    while (true) {
        const origStart = blocksStr.indexOf(ORIGINAL_MARKER, startIndex);
        if (origStart === -1) break;

        const origEnd = blocksStr.indexOf(DIVIDER_MARKER, origStart);
        if (origEnd === -1) {
            throw new Error('Malformed search/replace block: Missing ======= divider');
        }

        const updatedEnd = blocksStr.indexOf(UPDATED_MARKER, origEnd);
        if (updatedEnd === -1) {
            throw new Error('Malformed search/replace block: Missing >>>>>>> UPDATED marker');
        }

        blockCount++;

        const originalCode = blocksStr.substring(origStart + ORIGINAL_MARKER.length, origEnd).replace(/^\r?\n|\r?\n$/g, '');
        const updatedCode = blocksStr.substring(origEnd + DIVIDER_MARKER.length, updatedEnd).replace(/^\r?\n|\r?\n$/g, '');

        const matchIndex = content.indexOf(originalCode);
        if (matchIndex === -1) {
            throw new Error(`Original code block not found in the file:\n${originalCode}`);
        }

        const lastMatchIndex = content.lastIndexOf(originalCode);
        if (lastMatchIndex !== matchIndex) {
            throw new Error(`Original code block is not unique; it appears multiple times in the file:\n${originalCode}`);
        }

        content = content.substring(0, matchIndex) + updatedCode + content.substring(matchIndex + originalCode.length);

        startIndex = updatedEnd + UPDATED_MARKER.length;
    }

    if (blockCount === 0) {
        throw new Error('No valid search/replace blocks found in tool input. Format blocks as:\n<<<<<<< ORIGINAL\n...\n=======\n...\n>>>>>>> UPDATED');
    }

    return content;
}
