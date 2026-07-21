// Browser Automation Tool — Feature 8
// Provides headless browser automation using Playwright for testing and web interaction.

export class BrowserTool {
    private browser: any = null;
    private page: any = null;
    private consoleMessages: string[] = [];

    /**
     * Launch a browser and navigate to a URL.
     * Playwright is dynamically imported to avoid a hard dependency.
     */
    async launch(options: {
        headless?: boolean;
        url: string;
        viewportWidth?: number;
        viewportHeight?: number;
    }): Promise<string> {
        try {
            const playwright = require('playwright');
            this.browser = await playwright.chromium.launch({
                headless: options.headless ?? true,
            });

            const context = await this.browser.newContext({
                viewport: {
                    width: options.viewportWidth || 1280,
                    height: options.viewportHeight || 720
                }
            });

            this.page = await context.newPage();

            // Collect console messages
            this.consoleMessages = [];
            this.page.on('console', (msg: any) => {
                this.consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
            });

            await this.page.goto(options.url, { waitUntil: 'networkidle', timeout: 30000 });

            return `Browser launched and navigated to ${options.url}`;
        } catch (err: any) {
            if (err.message?.includes("Cannot find module 'playwright'")) {
                throw new Error(
                    'Playwright is not installed. Run: npm install playwright\n' +
                    'Then install browsers: npx playwright install chromium'
                );
            }
            throw err;
        }
    }

    /** Navigate to a new URL */
    async navigate(url: string): Promise<string> {
        if (!this.page) throw new Error('No browser page open. Call browser_open first.');
        await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        return `Navigated to ${url}`;
    }

    /** Take a screenshot and save to a temp file */
    async screenshot(): Promise<string> {
        if (!this.page) throw new Error('No browser page open');

        const tmpPath = require('path').join(
            require('os').tmpdir(),
            `blackide-screenshot-${Date.now()}.png`
        );

        await this.page.screenshot({ path: tmpPath, type: 'png', fullPage: false });
        return tmpPath;
    }

    /** Get page text content */
    async getPageContent(): Promise<string> {
        if (!this.page) throw new Error('No browser page open');
        const text = await this.page.evaluate(() => document.body.innerText);
        return (text || '').slice(0, 10000);
    }

    /** Get page HTML */
    async getPageHTML(): Promise<string> {
        if (!this.page) throw new Error('No browser page open');
        const html = await this.page.content();
        return (html || '').slice(0, 20000);
    }

    /** Click an element by CSS selector */
    async click(selector: string): Promise<string> {
        if (!this.page) throw new Error('No browser page open');
        await this.page.click(selector, { timeout: 5000 });
        return `Clicked: ${selector}`;
    }

    /** Type text into an input by CSS selector */
    async type(selector: string, text: string): Promise<string> {
        if (!this.page) throw new Error('No browser page open');
        await this.page.fill(selector, text, { timeout: 5000 });
        return `Typed "${text}" into ${selector}`;
    }

    /** Get console error/warning messages */
    getConsoleMessages(): string[] {
        return [...this.consoleMessages];
    }

    /** Get page title */
    async getTitle(): Promise<string> {
        if (!this.page) throw new Error('No browser page open');
        return await this.page.title();
    }

    /** Wait for a selector to appear */
    async waitForSelector(selector: string, timeoutMs: number = 5000): Promise<string> {
        if (!this.page) throw new Error('No browser page open');
        await this.page.waitForSelector(selector, { timeout: timeoutMs });
        return `Element found: ${selector}`;
    }

    /** Close the browser */
    async close(): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch {}
            this.browser = null;
            this.page = null;
            this.consoleMessages = [];
        }
    }

    /** Check if browser is active */
    get isActive(): boolean {
        return this.browser !== null && this.page !== null;
    }
}
