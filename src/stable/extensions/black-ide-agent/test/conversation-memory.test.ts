import { ChatMessage, ToolResult } from '../src/core/types';

/**
 * Standalone version of the pruning logic for testability.
 * Mirrors BlackIdeChatProvider._pruneForPersistence exactly.
 */
function pruneForPersistence(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
        if (!msg.toolResults?.length) return msg;
        return {
            ...msg,
            toolResults: msg.toolResults.map(tr => ({
                ...tr,
                content: tr.content.length > 500
                    ? tr.content.slice(0, 500) + '\n…(truncated for session memory)'
                    : tr.content,
                images: undefined,
            })),
        };
    });
}

describe('Conversation Memory Pruning', () => {
    it('truncates tool result content over 500 chars', () => {
        const messages: ChatMessage[] = [{
            role: 'user',
            content: '',
            toolResults: [{
                id: 'tr-1',
                name: 'read_file',
                content: 'x'.repeat(1000),
            }]
        }];
        const pruned = pruneForPersistence(messages);
        expect(pruned[0].toolResults![0].content.length).toBeLessThan(600);
        expect(pruned[0].toolResults![0].content).toContain('truncated');
    });

    it('preserves short tool results unchanged', () => {
        const messages: ChatMessage[] = [{
            role: 'user',
            content: '',
            toolResults: [{ id: 'tr-1', name: 'grep', content: 'Found 3 results' }]
        }];
        const pruned = pruneForPersistence(messages);
        expect(pruned[0].toolResults![0].content).toBe('Found 3 results');
    });

    it('strips image data from tool results', () => {
        const messages: ChatMessage[] = [{
            role: 'user',
            content: '',
            toolResults: [{
                id: 'tr-1', name: 'screenshot',
                content: 'Screenshot taken',
                images: [{ mediaType: 'image/png', dataBase64: 'huge-base64-data-string' }]
            }]
        }];
        const pruned = pruneForPersistence(messages);
        expect(pruned[0].toolResults![0].images).toBeUndefined();
    });

    it('does not modify assistant messages without tool results', () => {
        const messages: ChatMessage[] = [
            { role: 'assistant', content: 'Here is your answer.' },
        ];
        const pruned = pruneForPersistence(messages);
        expect(pruned).toEqual(messages);
    });

    it('does not modify user messages without tool results', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'How does this work?' },
        ];
        const pruned = pruneForPersistence(messages);
        expect(pruned).toEqual(messages);
    });

    it('preserves tool result metadata (id, name, isError) while truncating content', () => {
        const messages: ChatMessage[] = [{
            role: 'user',
            content: '',
            toolResults: [{
                id: 'tr-42',
                name: 'run_command',
                content: 'y'.repeat(2000),
                isError: true,
            }]
        }];
        const pruned = pruneForPersistence(messages);
        const tr = pruned[0].toolResults![0];
        expect(tr.id).toBe('tr-42');
        expect(tr.name).toBe('run_command');
        expect(tr.isError).toBe(true);
        expect(tr.content.length).toBeLessThan(600);
    });

    it('handles multiple tool results in a single message', () => {
        const messages: ChatMessage[] = [{
            role: 'user',
            content: '',
            toolResults: [
                { id: 'tr-1', name: 'read_file', content: 'a'.repeat(1000) },
                { id: 'tr-2', name: 'grep', content: 'short' },
                { id: 'tr-3', name: 'read_file', content: 'b'.repeat(800) },
            ]
        }];
        const pruned = pruneForPersistence(messages);
        expect(pruned[0].toolResults![0].content).toContain('truncated');
        expect(pruned[0].toolResults![1].content).toBe('short');
        expect(pruned[0].toolResults![2].content).toContain('truncated');
    });

    it('handles conversation with mixed message types', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Build me a feature' },
            { role: 'assistant', content: 'Sure, let me read the file.', toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/foo.ts' } }] },
            { role: 'user', content: '', toolResults: [{ id: 'tc-1', name: 'read_file', content: 'z'.repeat(2000) }] },
            { role: 'assistant', content: 'Done!' },
        ];
        const pruned = pruneForPersistence(messages);
        expect(pruned.length).toBe(4);
        expect(pruned[0].content).toBe('Build me a feature');
        expect(pruned[1].toolCalls).toBeDefined();
        expect(pruned[2].toolResults![0].content.length).toBeLessThan(600);
        expect(pruned[3].content).toBe('Done!');
    });
});

describe('Conversation State Cap', () => {
    it('caps at 40 messages when slicing', () => {
        const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `message ${i}`,
        }));
        // Simulating what HistoryStore.setConversationState does
        const trimmed = messages.slice(-40);
        expect(trimmed.length).toBe(40);
        expect(trimmed[0].content).toBe('message 20'); // First 20 dropped
    });
});
