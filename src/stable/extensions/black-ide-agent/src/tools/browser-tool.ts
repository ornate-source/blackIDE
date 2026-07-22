// Browser Automation Tool — Feature 8
// Provides headless browser automation using Playwright for testing and web interaction.

import { BrowserSettings, isNavigationAllowed } from './browser-capability';

export class BrowserTool {
    private browser: any = null;
    private page: any = null;
    private consoleMessages: string[] = [];
    private settings?: BrowserSettings;

    /** Optionally seed with resolved settings; also settable later via configure(). */
    constructor(settings?: BrowserSettings) {
        this.settings = settings;
    }

    /**
     * Apply user settings (executable path, headless, viewport, navigation allowlist). Called
     * once the persisted `general-settings` blob has been read, before the agent loop runs.
     */
    configure(settings: BrowserSettings): void {
        this.settings = settings;
    }

    /** Whether an auto-screenshot should follow each successful open/navigate (B8). */
    get shouldScreenshotOnNav(): boolean {
        return this.settings?.screenshotOnNav === true;
    }

    /**
     * Enforce the navigation allowlist (B2). A no-op when no allowlist is configured, so
     * default behavior is unchanged; otherwise an off-list host is refused before any request
     * leaves the machine. Throws so the caller surfaces it as a normal tool error.
     */
    private guardNavigation(url: string): void {
        const allowed = this.settings?.allowedDomains ?? [];
        if (!isNavigationAllowed(url, allowed)) {
            throw new Error(
                `Navigation to "${url}" is blocked by the browser allowlist. ` +
                `Allowed domains: ${allowed.join(', ') || '(none)'}.`
            );
        }
    }

    /**
     * Launch a browser and navigate to a URL.
     * Playwright is dynamically imported to avoid a hard dependency.
     * Explicit call options win over configured settings, which win over built-in defaults.
     */
    async launch(options: {
        headless?: boolean;
        url: string;
        viewportWidth?: number;
        viewportHeight?: number;
    }): Promise<string> {
        this.guardNavigation(options.url);
        try {
            const playwright = require('playwright');
            const headless = options.headless ?? this.settings?.headless ?? true;
            const launchOpts: any = { headless };
            if (this.settings?.executablePath) launchOpts.executablePath = this.settings.executablePath;
            this.browser = await playwright.chromium.launch(launchOpts);

            const context = await this.browser.newContext({
                viewport: {
                    width: options.viewportWidth || this.settings?.viewportWidth || 1280,
                    height: options.viewportHeight || this.settings?.viewportHeight || 720
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
                    'Playwright is not installed. Run the "Black IDE: Install Browser Support" command, ' +
                    'or manually: npm install playwright && npx playwright install chromium'
                );
            }
            throw err;
        }
    }

    /** Navigate to a new URL */
    async navigate(url: string): Promise<string> {
        if (!this.page) throw new Error('No browser page open. Call browser_open first.');
        this.guardNavigation(url);
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
