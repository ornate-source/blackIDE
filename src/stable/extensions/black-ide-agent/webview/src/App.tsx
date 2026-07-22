import { useState, useEffect, useRef, useReducer } from 'react';
import { agentReducer, initialAgentState, Message, AttachedFile, AgentState } from './agent-store';
import { ActivityPanel, TerminalPanel, ReviewPanel, CheckpointTimelinePanel, UndoMessageButton, PipelineLogPanel } from './AgentPanels';
import { ParallelSubagentsPanel } from './ParallelSubagents';
import { rawVscode } from './webview-bridge';

// Get VS Code API bridge
const vscode = rawVscode || {
  postMessage: (msg: any) => {
    console.log('VSCode PostMessage:', msg);
    if (msg.type === 'loadLlmConfig') {
      setTimeout(() => {
        window.postMessage({
          type: 'setLlmConfig',
          value: JSON.stringify([
            { id: 'google/gemini-flash', name: 'Google Gemini (Flash)', model: 'models/gemini-1.5-flash', type: 'google' },
            { id: 'anthropic/claude-sonnet', name: 'Claude 3.5 Sonnet', model: 'claude-3-5-sonnet-20240620', type: 'anthropic' },
            { id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', model: 'gpt-4o', type: 'openai' },
            { id: 'openrouter/llama3', name: 'Open Router Llama-3', model: 'meta-llama/llama-3-8b-instruct', type: 'openrouter' },
            { id: 'ollama/llama3', name: 'Local Ollama Llama 3', model: 'llama3:latest', type: 'ollama' }
          ], null, 2)
        }, '*');
      }, 100);
    } else if (msg.type === 'saveLlmConfig') {
      setTimeout(() => {
        window.postMessage({
          type: 'llmConfigSaved'
        }, '*');
      }, 100);
    } else if (msg.type === 'loadSettings') {
      setTimeout(() => {
        window.postMessage({
          type: 'setSettings',
          value: JSON.stringify({
            agentMode: 'strict',
            selectedModelId: 'google/gemini-flash',
            enableReasoningDisplay: true
          })
        }, '*');
      }, 100);
    } else if (msg.type === 'fetchModels') {
      setTimeout(() => {
        const provider = msg.value.provider;
        window.postMessage({
          type: 'fetchedModelsResult',
          success: true,
          value: [
            { id: `${provider}/mock-model-1`, name: `Mock ${provider.charAt(0).toUpperCase() + provider.slice(1)} Pro`, model: `mock-${provider}-pro` },
            { id: `${provider}/mock-model-2`, name: `Mock ${provider.charAt(0).toUpperCase() + provider.slice(1)} Lite`, model: `mock-${provider}-lite` },
            { id: `${provider}/mock-model-3`, name: `Mock ${provider.charAt(0).toUpperCase() + provider.slice(1)} Ultra`, model: `mock-${provider}-ultra` }
          ]
        }, '*');
      }, 800);
    }
  },
  getState: () => ({}),
  setState: (state: any) => { console.log('State set:', state); }
};



interface LLMConfigEntry {
  id: string;
  name: string;
  type: 'google' | 'claude' | 'openai' | 'openrouter' | 'local';
  url?: string;
  apiKey?: string;
  model?: string;
  enabled?: boolean;
}

interface ProviderSetting {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
}

interface BlackIDESettings {
  // Permissions
  autoApproveFileEdits: boolean;
  autoApproveTerminal: boolean;
  autoApproveFileCreate: boolean;
  // Browser
  browserEnabled: boolean;
  browserPath: string;
  browserHeadless: boolean;
  browserViewportWidth: number;
  browserViewportHeight: number;
  browserAllowedDomains: string;
  browserScreenshotOnNav: boolean;
  // Agent behavior
  maxLoopIterations: number;
  enableFastApply: boolean;
  enableReasoningDisplay: boolean;
  customSystemPrompt: string;
  selectedModelId?: string;
  // Multi-agent pipeline
  pipelineAutoOpenAllFiles: boolean;
  // Cumulative (input+output) token ceiling for one pipeline run. 0 = unlimited.
  pipelineTokenBudget: number;
  // What a completed run does with its work: 'apply' reconciles onto the live working
  // tree (default), 'pr' leaves it on its branch and opens a pull request.
  pipelineOutputMode: 'apply' | 'pr';
  // Experimental, default off: run each dependency wave's phases concurrently in separate
  // worktrees. Not yet covered by extension-host integration tests.
  pipelineParallelExecution: boolean;
  // Mode name (e.g. "Backend Executor") -> LLMConfigEntry id. Unset/unresolvable
  // entries fall back to the pipeline's main selected model.
  pipelinePhaseModels: Record<string, string>;
  // Autocomplete
  enableAutocomplete: boolean;
  autocompleteModelId?: string;
  autocompleteDebounce?: number;
  allowAnonymousTelemetry?: boolean;
  // Providers list
  providers?: Record<string, ProviderSetting>;
}

const DEFAULT_PROVIDERS: Record<string, ProviderSetting> = {
  google: { enabled: true, apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com' },
  anthropic: { enabled: true, apiKey: '', baseUrl: 'https://api.anthropic.com' },
  openai: { enabled: true, apiKey: '', baseUrl: 'https://api.openai.com' },
  openrouter: { enabled: true, apiKey: '', baseUrl: 'https://openrouter.ai' },
  ollama: { enabled: false, apiKey: '', baseUrl: 'http://localhost:11434' },
  lmstudio: { enabled: false, apiKey: '', baseUrl: 'http://localhost:1234' },
  'llama.cpp': { enabled: false, apiKey: '', baseUrl: 'http://localhost:8080' },
};

const DEFAULT_SETTINGS: BlackIDESettings = {
  autoApproveFileEdits: false,
  autoApproveTerminal: false,
  autoApproveFileCreate: false,
  browserEnabled: false,
  browserPath: '',
  browserHeadless: true,
  browserViewportWidth: 1280,
  browserViewportHeight: 720,
  browserAllowedDomains: '',
  browserScreenshotOnNav: false,
  maxLoopIterations: 25,
  enableFastApply: true,
  enableReasoningDisplay: true,
  customSystemPrompt: '',
  selectedModelId: '',
  pipelineAutoOpenAllFiles: false,
  pipelineTokenBudget: 0,
  pipelineOutputMode: 'apply',
  pipelineParallelExecution: false,
  pipelinePhaseModels: {},
  enableAutocomplete: true,
  autocompleteModelId: '',
  autocompleteDebounce: 250,
  allowAnonymousTelemetry: true,
  providers: DEFAULT_PROVIDERS,
};

const DEFAULT_TEMPLATE: LLMConfigEntry[] = [
  {
    "id": "gemini-2.5-flash",
    "name": "Google Gemini (Flash)",
    "type": "google",
    "model": "gemini-2.5-flash",
    "apiKey": "",
    "enabled": true
  },
  {
    "id": "claude-3-5-sonnet",
    "name": "Claude 3.5 Sonnet",
    "type": "claude",
    "model": "claude-3-5-sonnet-20241022",
    "apiKey": "",
    "enabled": true
  },
  {
    "id": "openai-gpt-4o",
    "name": "OpenAI GPT-4o",
    "type": "openai",
    "url": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4o",
    "apiKey": "",
    "enabled": true
  },
  {
    "id": "openrouter-free",
    "name": "Open Router Llama-3",
    "type": "openrouter",
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "model": "meta-llama/llama-3-8b-instruct:free",
    "apiKey": "",
    "enabled": true
  },
  {
    "id": "local-ollama",
    "name": "Local Ollama Llama 3",
    "type": "local",
    "url": "http://localhost:11434/v1/chat/completions",
    "model": "llama3",
    "enabled": true
  }
];

const groupModels = (models: LLMConfigEntry[]) => {
  const groups: Record<string, LLMConfigEntry[]> = {
    'Google': [],
    'Anthropic': [],
    'OpenAI': [],
    'Open Router': [],
    'Ollama': [],
    'LM Studio': [],
    'llama.cpp': [],
    'Other': []
  };

  models.forEach(model => {
    if (model.id.startsWith('google/')) {
      groups['Google'].push(model);
    } else if (model.id.startsWith('anthropic/')) {
      groups['Anthropic'].push(model);
    } else if (model.id.startsWith('openai/')) {
      groups['OpenAI'].push(model);
    } else if (model.id.startsWith('openrouter/')) {
      groups['Open Router'].push(model);
    } else if (model.id.startsWith('ollama/')) {
      groups['Ollama'].push(model);
    } else if (model.id.startsWith('lmstudio/')) {
      groups['LM Studio'].push(model);
    } else if (model.id.startsWith('llama.cpp/')) {
      groups['llama.cpp'].push(model);
    } else {
      if (model.type === 'google') groups['Google'].push(model);
      else if (model.type === 'claude') groups['Anthropic'].push(model);
      else if (model.type === 'openai') {
        if (model.url && model.url.includes('1234')) groups['LM Studio'].push(model);
        else if (model.url && model.url.includes('8080')) groups['llama.cpp'].push(model);
        else groups['OpenAI'].push(model);
      }
      else if (model.type === 'openrouter') groups['Open Router'].push(model);
      else if (model.type === 'local') groups['Ollama'].push(model);
      else groups['Other'].push(model);
    }
  });

  return groups;
};

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  openrouter: 'Open Router',
  ollama: 'Local Ollama',
  lmstudio: 'LM Studio',
  'llama.cpp': 'llama.cpp'
};

const agentAvatar = (window as any).agentAvatarUri || '';

// ─── SVG Icon Components ────────────────────────────────────────────────────
const SendIcon = () => (
  <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2.5" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </svg>
);



const PlusIcon = () => (
  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
  </svg>
);

const AttachIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
  </svg>
);

const ImageIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
  </svg>
);

const AtIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10h5v-2h-5c-4.34 0-8-3.66-8-8s3.66-8 8-8 8 3.66 8 8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57V12c0-2.76-2.24-5-5-5s-5 2.24-5 5 2.24 5 5 5c1.38 0 2.64-.56 3.54-1.47.65.89 1.77 1.47 2.96 1.47 1.97 0 3.5-1.6 3.5-3.57V12c0-5.52-4.48-10-10-10zm0 13c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z" />
  </svg>
);

const BackIcon = () => (
  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
  </svg>
);

/*
const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg className={`w-3.5 h-3.5 fill-current transition-transform duration-200 ${open ? 'rotate-90' : ''}`} viewBox="0 0 24 24">
    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
  </svg>
);
*/

const TrashIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
  </svg>
);

/*
const EyeIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
  </svg>
);

const EyeOffIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
  </svg>
);
*/

const HistoryIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3-1.07-3-3s1.07-3 3-3 3 1.07 3 3-1.07 3-3 3z" />
  </svg>
);

const StopIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="3" width="10" height="10" rx="1" />
  </svg>
);

// ─── Checkbox Row Component ──────────────────────────────────────────────────
const CheckboxRow = ({
  id,
  title,
  description,
  checked,
  onToggle,
  disabled = false,
  icon
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) => (
  <div className={`flex items-start justify-between gap-4 py-4 border-b border-[rgba(255,255,255,0.04)] last:border-0 ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
    <div className="flex items-start gap-3 flex-1 min-w-0">
      {icon && (
        <div className="w-8 h-8 rounded-lg bg-[rgba(255,255,255,0.03)] text-foreground/40 flex items-center justify-center shrink-0 mt-0.5">
          {icon}
        </div>
      )}
      <label htmlFor={id} className="cursor-pointer select-none flex-1 min-w-0">
        <span className="text-[12.5px] font-medium text-foreground block">{title}</span>
        <span className="text-[11px] text-muted/50 leading-relaxed block mt-0.5">{description}</span>
      </label>
    </div>
    <div
      id={id}
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      className={`toggle-switch shrink-0 mt-1.5 ${checked ? 'active' : ''}`}
    />
  </div>
);

/*
// ─── Provider Status Badge ──────────────────────────────────────────────────
const ProviderBadge = ({ type }: { type: LLMConfigEntry['type'] }) => {
  const colors: Record<string, string> = {
    google: 'bg-blue-500/20 text-blue-400',
    claude: 'bg-orange-500/20 text-orange-400',
    openai: 'bg-green-500/20 text-green-400',
    openrouter: 'bg-purple-500/20 text-purple-400',
    local: 'bg-yellow-500/20 text-yellow-400',
  };
  const labels: Record<string, string> = {
    google: 'Google',
    claude: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    local: 'Local',
  };
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${colors[type] || 'bg-gray-500/20 text-gray-400'}`}>
      {labels[type] || type}
    </span>
  );
};
*/


const getMessageAgentState = (msg: Message): AgentState => {
  return {
    phase: msg.phase || 'idle',
    turn: msg.activity ? msg.activity.filter(a => a.status !== 'running').length + 1 : 0,
    startedAt: msg.startedAt,
    endedAt: msg.endedAt,
    activity: msg.activity || [],
    pipelineLog: msg.pipelineLog || [],
    terminal: msg.terminal || [],
    plan: [],
    artifacts: [],
    checkpoints: [],
    error: msg.error,
    tokens: msg.tokens,
    mode: 'agent',
    model: '',
  };
};


export default function App() {
  const [activeView, setActiveView] = useState<'chat' | 'settings'>((window as any).isSettingsPanel ? 'settings' : 'chat');
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<string>('permissions');
  const [messages, setMessages] = useState<Message[]>(() => {
    const state = vscode.getState();
    if (state?.messages) {
      // Re-hydrate Date objects since they come back as strings from postMessage/state
      return state.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
    }
    return [
      {
        id: '1',
        sender: 'agent',
        text: 'Hello! I am your AI coding assistant. Ask me anything, or request an agentic task to modify files and run commands in your workspace!',
        timestamp: new Date()
      }
    ];
  });
  const [inputText, setInputText] = useState('');
  const [agentLogs, setAgentLogs] = useState<string[]>([
    'Agent Engine initialized successfully.',
    'System standby. Awaiting user commands.'
  ]);

  // Chat history state
  const [historyThreads, setHistoryThreads] = useState<any[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => {
    const state = vscode.getState();
    return state?.activeThreadId || null;
  });
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);

  // Persist UI chat state across window reloads
  useEffect(() => {
    vscode.setState({ messages, activeThreadId });
  }, [messages, activeThreadId]);

  // Dropdown autocomplete state
  const [showContextDropdown, setShowContextDropdown] = useState(false);
  const [contextSuggestions, setContextSuggestions] = useState<string[]>([]);
  const [contextDropdownIndex, setContextDropdownIndex] = useState(0);

  const [showSlashDropdown, setShowSlashDropdown] = useState(false);
  const [slashSuggestions] = useState<string[]>(['/explain', '/test', '/fix', '/commit', '/refactor', '/docs', '/search', '/plan', '/compact']);
  const [slashDropdownIndex, setSlashDropdownIndex] = useState(0);

  // JSON Configuration States (values tracked internally for save operations)
  const [_jsonConfigText, setJsonConfigText] = useState('');
  const [modelsList, setModelsList] = useState<LLMConfigEntry[]>(DEFAULT_TEMPLATE);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [_validationError, setValidationError] = useState<string | null>(null);
  
  // Generation & Reasoning States
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentReasoningText, setCurrentReasoningText] = useState('');
  const [isReasoningExpanded, setIsReasoningExpanded] = useState(true);
  const [tokenUsage, setTokenUsage] = useState<{ turnTokens: string; totalTokens: string; totalCost: string; turns: number } | null>(null);
  const [loopLimitWarning, setLoopLimitWarning] = useState<{ currentTurn: number; maxTurns: number; remaining: number } | null>(null);
  // Agent surfaces — mode, live plan/TODO, artifacts, checkpoint
  const [agentMode, setAgentMode] = useState<string>('agent');
  const [customModes, setCustomModes] = useState<any[]>([]);
  const [agentArtifacts, setAgentArtifacts] = useState<{ name: string; type: string; path: string }[]>([]);

  // Activity, terminal, plan and file-review are all projections of the agent's event
  // stream. One reducer owns them, rather than a useState per surface.
  const [agentState, dispatchAgent] = useReducer(agentReducer, initialAgentState);
  const agentPlan = agentState.plan;

  // Input enhancement states
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  // Settings state
  const [settings, setSettings] = useState<BlackIDESettings>(DEFAULT_SETTINGS);
  /*
  const [settingsExpandedSections, setSettingsExpandedSections] = useState<Record<string, boolean>>({
    providers: true,
    permissions: false,
    browser: false,
    behavior: false,
    autocomplete: false,
    about: false,
  });
  */
  const [providerPasswordVisible, setProviderPasswordVisible] = useState<Record<string, boolean>>({});
  // const [syncingProviders, setSyncingProviders] = useState<Record<string, boolean>>({});
  // const [providerSyncStatus, setProviderSyncStatus] = useState<Record<string, string>>({});
  const [showJsonConfigModal, setShowJsonConfigModal] = useState(false);
  const [jsonEditText, setJsonEditText] = useState('');
  const [connectProvider, setConnectProvider] = useState<string>('google');
  const [connectApiKey, setConnectApiKey] = useState<string>('');
  const [connectBaseUrl, setConnectBaseUrl] = useState<string>('https://generativelanguage.googleapis.com');
  const [isFetchingModels, setIsFetchingModels] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showModelSelectionPopup, setShowModelSelectionPopup] = useState<boolean>(false);
  const [fetchedModelsList, setFetchedModelsList] = useState<LLMConfigEntry[]>([]);
  const [selectedModelIdsToSave, setSelectedModelIdsToSave] = useState<Set<string>>(new Set());
  const [modelFilterText, setModelFilterText] = useState<string>('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  useEffect(() => {
    const defaults: Record<string, string> = {
      google: 'https://generativelanguage.googleapis.com',
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com',
      openrouter: 'https://openrouter.ai',
      ollama: 'http://localhost:11434',
      lmstudio: 'http://localhost:1234',
      'llama.cpp': 'http://localhost:8080'
    };
    setConnectBaseUrl(defaults[connectProvider] || '');
    setConnectApiKey('');
    setFetchError(null);
  }, [connectProvider]);
  /*
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  */

  const chatEndRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Auto-resize textarea height as content changes
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputText]);

  // Close menus when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsDropdown(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Request the stored LLM config from Extension Host on mount
  useEffect(() => {
    vscode.postMessage({ type: 'loadLlmConfig' });
    vscode.postMessage({ type: 'loadSettings' });
    vscode.postMessage({ type: 'loadHistory' });

    // Initial sync of the restored state to the host
    const state = vscode.getState();
    if (state?.activeThreadId) {
      vscode.postMessage({ type: 'switchThread', value: state.activeThreadId });
    }
  }, []);

  // Sync active thread or set initial
  useEffect(() => {
    if (!activeThreadId) {
      const newId = Math.random().toString();
      setActiveThreadId(newId);
      // Ensure backend knows we're starting a new thread if one was generated
      vscode.postMessage({ type: 'newConversation', value: newId });
    }
  }, [activeThreadId]);

  // Automatically save history thread when messages update
  useEffect(() => {
    if (messages.length > 1 && activeThreadId) {
      const firstUserMsg = messages.find(m => m.sender === 'user');
      const title = firstUserMsg ? firstUserMsg.text.slice(0, 30) : 'New Conversation';
      vscode.postMessage({
        type: 'saveHistoryThread',
        value: {
          id: activeThreadId,
          title: title,
          messages: messages
        }
      });
    }
  }, [messages, activeThreadId]);

  // Handle incoming postMessages from Extension Host
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'setLlmConfig':
          const rawConfig = message.value;
          if (rawConfig) {
            setJsonConfigText(rawConfig);
            try {
              const parsed = JSON.parse(rawConfig);
              if (Array.isArray(parsed)) {
                setModelsList(parsed);
                setValidationError(null);
                if (parsed.length > 0 && !selectedModelId) {
                  setSelectedModelId(parsed[0].id);
                }
              }
            } catch (err) {
              // Keep modelsList as default if parsed fails
            }
          } else {
            const defaultText = JSON.stringify(DEFAULT_TEMPLATE, null, 2);
            setJsonConfigText(defaultText);
            setModelsList(DEFAULT_TEMPLATE);
            setSelectedModelId(DEFAULT_TEMPLATE[0].id);
            vscode.postMessage({ type: 'saveLlmConfig', value: defaultText });
          }
          break;
        case 'llmConfigSaved':
          vscode.postMessage({ type: 'loadLlmConfig' });
          break;
        case 'fetchedModelsResult':
          setIsFetchingModels(false);
          if (message.success) {
            setFetchError(null);
            setFetchedModelsList(message.value || []);
            const ids = new Set<string>((message.value || []).map((m: any) => m.id));
            setSelectedModelIdsToSave(ids);
            setShowModelSelectionPopup(true);
          } else {
            setFetchError(message.error || 'Failed to fetch models from provider.');
          }
          break;
        case 'setSettings':
          if (message.value) {
            try {
              const parsed = typeof message.value === 'string' ? JSON.parse(message.value) : message.value;
              const mergedProviders = { ...DEFAULT_PROVIDERS, ...(parsed?.providers || {}) };
              setSettings({ ...DEFAULT_SETTINGS, ...parsed, providers: mergedProviders });
              if (parsed.selectedModelId) {
                setSelectedModelId(parsed.selectedModelId);
              }
            } catch {}
          }
          break;
        case 'navToSettings':
          setActiveView('settings');
          break;
        case 'fileAttached':
          if (message.value) {
            setAttachedFiles(prev => [...prev, message.value]);
          }
          break;
        case 'startReasoning':
          setCurrentReasoningText('');
          break;
        case 'streamReasoning':
          setCurrentReasoningText(prev => prev + message.value);
          break;
        case 'finalResponse':
          setMessages(prev => {
            const streamingMsg = prev.find(m => m.id === 'streaming-agent-response');
            if (streamingMsg) {
              return prev.map(m =>
                m.id === 'streaming-agent-response'
                  ? {
                      ...m,
                      id: 'agent-response-' + Math.random(),
                      text: message.value,
                      status: 'done',
                      timestamp: new Date(),
                    }
                  : m
              );
            } else {
              return [
                ...prev,
                {
                  id: 'agent-response-' + Math.random(),
                  sender: 'agent',
                  text: message.value,
                  timestamp: new Date(),
                  status: 'done',
                }
              ];
            }
          });
          break;
        case 'taskComplete':
          setIsGenerating(false);
          setCurrentReasoningText('');
          setLoopLimitWarning(null);
          setMessages(prev => prev.map(m =>
            m.id === 'streaming-agent-response'
              ? { ...m, id: 'agent-response-' + Math.random(), status: 'done' }
              : m
          ));
          break;
        case 'taskError':
          setIsGenerating(false);
          setCurrentReasoningText('');
          setLoopLimitWarning(null);
          setMessages(prev => {
            const streamingMsg = prev.find(m => m.id === 'streaming-agent-response');
            if (streamingMsg) {
              return prev.map(m =>
                m.id === 'streaming-agent-response'
                  ? {
                      ...m,
                      id: 'error-' + Math.random(),
                      text: `⚠️ Request Failed:\n${message.value || 'Unknown error occurred while contacting LLM.'}`,
                      status: 'done',
                      timestamp: new Date(),
                      error: message.value || 'Unknown error occurred.',
                    }
                  : m
              );
            } else {
              return [
                ...prev,
                {
                  id: 'error-' + Math.random(),
                  sender: 'agent',
                  text: `⚠️ Request Failed:\n${message.value || 'Unknown error occurred while contacting LLM.'}`,
                  timestamp: new Date(),
                  status: 'done',
                  error: message.value || 'Unknown error occurred.',
                }
              ];
            }
          });
          break;
        case 'log':
          setAgentLogs(prev => [...prev, message.value]);
          break;
        case 'searchFilesResponse':
          if (message.value) {
            setContextSuggestions(message.value);
          }
          break;
        case 'setHistory':
          if (message.value) {
            setHistoryThreads(message.value);
          }
          break;
        case 'ollamaDetected':
          if (message.value) {
            setModelsList(prev => {
              const updated = [...prev];
              for (const model of message.value) {
                if (!updated.some(m => m.id === model.id)) {
                  updated.push(model);
                }
              }
              const json = JSON.stringify(updated, null, 2);
              vscode.postMessage({ type: 'saveLlmConfig', value: json });
              return updated;
            });
          }
          break;
        case 'setMode':
        case 'agentMode':
          if (message.value) {
            setAgentMode(message.value);
          }
          break;
        case 'modesLoaded':
          if (Array.isArray(message.value)) {
            setCustomModes(message.value);
          }
          break;
        case 'tokenUsage':
          if (message.value) {
            setTokenUsage(message.value);
          }
          break;
        case 'loopLimitWarning':
          if (message.value) {
            setLoopLimitWarning(message.value);
          }
          break;
        // Everything the runtime publishes arrives here as one typed event.
        case 'agentEvent':
          if (message.value) {
            dispatchAgent(message.value);
            if (message.value.type === 'ArtifactCreated') {
              const art = message.value.artifact;
              setAgentArtifacts(prev => [...prev.filter(a => a.path !== art.path), art]);
            }
            if (message.value.type === 'Log') {
              setAgentLogs(prev => [...prev, message.value.message]);
            }

            const event = message.value;
            setMessages(prev => prev.map(msg => {
              if (msg.id !== 'streaming-agent-response') return msg;

              const activity = msg.activity || [];
              const terminal = msg.terminal || [];

              switch (event.type) {
                case 'TaskStarted':
                  return {
                    ...msg,
                    phase: 'planning',
                    startedAt: event.ts,
                    activity: [],
                    terminal: [],
                  };
                case 'PlanApprovalRequested':
                  return { ...msg, phase: 'awaiting_approval' };
                case 'TurnStarted':
                  return { ...msg, phase: 'reasoning' };
                case 'ToolStarted':
                  return {
                    ...msg,
                    phase: 'tool',
                    activity: [...activity, {
                      id: event.toolCallId,
                      name: event.name,
                      summary: event.summary,
                      arguments: event.arguments,
                      status: 'running',
                      startedAt: event.ts,
                    }],
                  };
                case 'ToolFinished':
                  return {
                    ...msg,
                    activity: activity.map(t =>
                      t.id === event.toolCallId
                        ? { 
                            ...t, 
                            status: event.ok ? 'ok' : 'error', 
                            durationMs: event.durationMs, 
                            summary: event.ok ? t.summary : event.summary,
                            output: event.output 
                          }
                        : t
                    ),
                  };
                case 'TerminalChunk':
                  return {
                    ...msg,
                    terminal: [...terminal, { stream: event.stream, text: event.text }].slice(-500),
                  };
                case 'TokenUsage':
                  return {
                    ...msg,
                    tokens: {
                      inputTokens: event.inputTokens,
                      outputTokens: event.outputTokens,
                      cachedInputTokens: event.cachedInputTokens,
                      cost: event.cost,
                      turns: event.turns,
                    },
                  };
                case 'TaskCompleted':
                  return { ...msg, phase: 'completed', endedAt: event.ts };
                case 'TaskFailed':
                  return { ...msg, phase: 'failed', endedAt: event.ts, error: event.error };
                case 'TaskCancelled':
                  return { ...msg, phase: 'cancelled', endedAt: event.ts };
                case 'PipelineStarted':
                  return {
                    ...msg,
                    phase: 'planning',
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_start_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: 'Orchestrator',
                            type: 'info',
                            message: `Pipeline started with phases: ${event.phases.join(', ')}`
                        }
                    ]
                  };
                case 'PipelinePhaseStarted':
                  return {
                    ...msg,
                    // A retried phase re-announces itself as started — clear a prior
                    // 'failed' status (and its error banner) so the UI reflects that
                    // the pipeline is actually still running, not dead.
                    phase: msg.phase === 'failed' ? 'planning' : msg.phase,
                    error: msg.phase === 'failed' ? undefined : msg.error,
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: event.phase,
                            type: 'phase_start',
                            message: `Started phase: ${event.phase} (${event.index}/${event.total})`
                        }
                    ]
                  };
                case 'PipelinePhaseCompleted':
                  return {
                    ...msg,
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: event.phase,
                            type: 'phase_complete',
                            message: `Completed phase: ${event.phase}`
                        }
                    ]
                  };
                case 'PipelinePhaseError':
                  return {
                    ...msg,
                    phase: 'failed',
                    error: event.error,
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: event.phase,
                            type: 'error',
                            message: `Phase ${event.phase} failed: ${event.error}`
                        }
                    ]
                  };
                case 'FileChanged':
                  return {
                    ...msg,
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: msg.phase || 'running',
                            type: event.kind === 'created' ? 'file_created' : 'file_modified',
                            message: `${event.kind === 'created' ? 'Created' : 'Modified'} ${event.path}`,
                            filePath: event.path
                        }
                    ]
                  };
                case 'MindmapUpdated':
                  return {
                    ...msg,
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: 'Orchestrator',
                            type: 'file_modified',
                            message: `Updated OpenSpec Mindmap`,
                            filePath: event.path
                        }
                    ]
                  };
                case 'PipelineCompleted':
                  return {
                    ...msg,
                    pipelineLog: [
                        ...(msg.pipelineLog || []),
                        {
                            id: `pl_${event.ts || Date.now()}`,
                            timestamp: event.ts || Date.now(),
                            phase: 'Orchestrator',
                            type: 'file_created',
                            message: `Pipeline complete — overview.md generated`,
                            filePath: event.overviewPath
                        }
                    ]
                  };
                default:
                  return msg;
              }
            }));
          }
          break;
        case 'checkpointAvailable':
          // The task just committed a checkpoint — ask for the authoritative list.
          vscode.postMessage({ type: 'listCheckpoints' });
          // Pin the checkpoint's messageId to the most recent user message so its
          // Undo button (MF-43) can find the checkpoint by messageId.
          if (message.value?.messageId) {
            const linkId = message.value.messageId;
            setMessages(prev => {
              const idx = [...prev].reverse().findIndex(m => m.sender === 'user');
              if (idx === -1) return prev;
              const realIdx = prev.length - 1 - idx;
              if (prev[realIdx].taskId === linkId) return prev;
              const next = [...prev];
              next[realIdx] = { ...next[realIdx], taskId: linkId };
              return next;
            });
          }
          break;
        case 'setCheckpoints':
          if (Array.isArray(message.value)) {
            dispatchAgent({ type: 'checkpoints', value: message.value });
          }
          break;
        case 'checkpointDiffResult':
          if (message.value) {
            dispatchAgent({ type: 'setCheckpointDiff', ...message.value });
          }
          break;
        case 'planApprovalRequested':
          if (message.value) {
            setIsGenerating(false); // Stop spinner — we're waiting for user review
            dispatchAgent({
              type: 'PlanApprovalRequested',
              planContent: message.value.planContent,
              taskContent: message.value.taskContent,
              planPath: message.value.planPath,
              taskPath: message.value.taskPath,
              ts: Date.now(),
            });
          }
          break;
        case 'planRejected':
          setIsGenerating(false);
          dispatchAgent({ type: 'PlanRejected', ts: Date.now() });
          break;
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [selectedModelId, messages, activeThreadId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentReasoningText]);

  const handleCancelTask = () => {
    setIsGenerating(false);
    setCurrentReasoningText('');
    setLoopLimitWarning(null);
    setMessages(prev => {
      const streamingMsg = prev.find(m => m.id === 'streaming-agent-response');
      if (streamingMsg) {
        return prev.map(m =>
          m.id === 'streaming-agent-response'
            ? {
                ...m,
                id: 'cancel-' + Math.random(),
                text: m.text || '⚠️ Task cancelled by user.',
                status: 'done',
                phase: 'cancelled',
                endedAt: Date.now(),
              }
            : m
        );
      } else {
        return [
          ...prev,
          {
            id: 'cancel-' + Math.random(),
            sender: 'agent',
            text: '⚠️ Task cancelled by user.',
            timestamp: new Date(),
            status: 'done',
            phase: 'cancelled',
          }
        ];
      }
    });
    vscode.postMessage({ type: 'stopAgentTask' });
  };

  const handleSendMessage = () => {
    if (!inputText.trim() || isGenerating) return;
    if (!selectedModelId) {
      vscode.postMessage({ type: 'showError', value: 'Please select a model provider. If empty, configure one in Settings.' });
      return;
    }

    const userMsg: Message = {
      id: Math.random().toString(),
      sender: 'user',
      text: inputText,
      timestamp: new Date(),
      attachments: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    };

    const agentPlaceholderMsg: Message = {
      id: 'streaming-agent-response',
      sender: 'agent',
      text: '',
      timestamp: new Date(),
      status: 'running'
    };

    setIsGenerating(true);
    setMessages(prev => [...prev, userMsg, agentPlaceholderMsg]);
    setInputText('');
    setAttachedFiles([]);
    setCurrentReasoningText('');
    setLoopLimitWarning(null);
    // Plan, activity and terminal all reset from the TaskStarted event.

    vscode.postMessage({
      type: 'startAgentTask',
      prompt: inputText,
      modelId: selectedModelId,
      attachments: attachedFiles,
      mode: agentMode,
    });
  };

  const handleInputChange = (text: string) => {
    setInputText(text);

    // Slash command check
    if (text.startsWith('/') && !text.includes(' ')) {
      const match = slashSuggestions.filter(s => s.startsWith(text));
      if (match.length > 0) {
        setShowSlashDropdown(true);
        setShowContextDropdown(false);
        return;
      }
    } else {
      setShowSlashDropdown(false);
    }

    // Mention check
    const atIndex = text.lastIndexOf('@');
    if (atIndex !== -1 && atIndex >= text.length - 15) {
      const query = text.slice(atIndex + 1);
      if (!query.includes(' ') && !query.includes('\n')) {
        vscode.postMessage({ type: 'searchFiles', value: query });
        setShowContextDropdown(true);
        setShowSlashDropdown(false);
        return;
      }
    }
    setShowContextDropdown(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashDropdownIndex(prev => (prev + 1) % slashSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashDropdownIndex(prev => (prev - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        setInputText(slashSuggestions[slashDropdownIndex] + ' ');
        setShowSlashDropdown(false);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashDropdown(false);
        return;
      }
    }

    if (showContextDropdown && contextSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setContextDropdownIndex(prev => (prev + 1) % contextSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setContextDropdownIndex(prev => (prev - 1 + contextSuggestions.length) % contextSuggestions.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const atIndex = inputText.lastIndexOf('@');
        const file = contextSuggestions[contextDropdownIndex];
        const newText = inputText.slice(0, atIndex) + `@${file} `;
        setInputText(newText);
        setShowContextDropdown(false);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowContextDropdown(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleSelectThread = (thread: any) => {
    setActiveThreadId(thread.id);
    setMessages(thread.messages);
    dispatchAgent({ type: 'ResetTask' });
    setShowHistoryDrawer(false);
    // Sync host-side conversation state for multi-turn continuity
    vscode.postMessage({ type: 'switchThread', value: thread.id });
  };

  const handleNewChat = () => {
    const newId = Math.random().toString();
    setActiveThreadId(newId);
    setMessages([
      {
        id: '1',
        sender: 'agent',
        text: 'Hello! I am your AI coding assistant. Ask me anything, or request an agentic task to modify files and run commands in your workspace!',
        timestamp: new Date()
      }
    ]);
    dispatchAgent({ type: 'ResetTask' });
    setTokenUsage(null);
    setShowHistoryDrawer(false);
    // Sync host-side conversation reset
    vscode.postMessage({ type: 'newConversation', value: newId });
  };

  const handleDeleteThread = (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'deleteHistoryThread', value: threadId });
    if (activeThreadId === threadId) {
      handleNewChat();
    }
  };


  // Settings handlers
  const updateSetting = <K extends keyof BlackIDESettings>(key: K, value: BlackIDESettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      vscode.postMessage({ type: 'saveSettings', value: JSON.stringify(next) });
      return next;
    });
  };

  const fetchModelsFromProvider = () => {
    if (isFetchingModels) return;
    setFetchError(null);
    setIsFetchingModels(true);
    vscode.postMessage({
      type: 'fetchModels',
      value: {
        provider: connectProvider,
        apiKey: connectApiKey,
        baseUrl: connectBaseUrl
      }
    });
  };

  /*
  const updateProviderSetting = (providerKey: string, field: keyof ProviderSetting, value: string | boolean) => {
    setSettings(prev => {
      const providers = prev.providers || DEFAULT_PROVIDERS;
      const provider = providers[providerKey] || { enabled: false, apiKey: '', baseUrl: '' };
      const nextProviders = {
        ...providers,
        [providerKey]: {
          ...provider,
          [field]: value
        }
      };
      const next = { ...prev, providers: nextProviders };
      vscode.postMessage({ type: 'saveSettings', value: JSON.stringify(next) });
      return next;
    });
  };

  const detectModels = async (providerKey: string) => {
    const prov = settings.providers?.[providerKey];
    if (!prov) return;
    if (!prov.enabled) {
      setProviderSyncStatus(prev => ({ ...prev, [providerKey]: 'Provider is disabled.' }));
      return;
    }

    setSyncingProviders(prev => ({ ...prev, [providerKey]: true }));
    setProviderSyncStatus(prev => ({ ...prev, [providerKey]: 'Syncing models...' }));

    try {
      let detected: LLMConfigEntry[] = [];
      const apiKey = prov.apiKey;
      const baseUrl = prov.baseUrl;

      if (providerKey === 'google') {
        if (!apiKey) throw new Error('API Key is required.');
        const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models?key=${apiKey}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        const data = await response.json();
        if (data.models && Array.isArray(data.models)) {
          detected = data.models
            .filter((m: any) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => {
              const modelName = m.name.replace('models/', '');
              return {
                id: `google/${modelName}`,
                name: `Google: ${m.displayName || modelName}`,
                type: 'google' as const,
                model: modelName,
                apiKey: apiKey,
                url: `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}`,
                enabled: true
              };
            });
        }
      } else if (providerKey === 'openai') {
        if (!apiKey) throw new Error('API Key is required.');
        const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        const data = await response.json();
        if (data.data && Array.isArray(data.data)) {
          detected = data.data
            .filter((m: any) => m.id.startsWith('gpt') || m.id.startsWith('o1'))
            .map((m: any) => ({
              id: `openai/${m.id}`,
              name: `OpenAI: ${m.id}`,
              type: 'openai' as const,
              model: m.id,
              apiKey: apiKey,
              url: `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
              enabled: true
            }));
        }
      } else if (providerKey === 'anthropic') {
        if (!apiKey) throw new Error('API Key is required.');
        try {
          const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
          const response = await fetch(url, {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
              'Content-Type': 'application/json'
            }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.data && Array.isArray(data.data)) {
              detected = data.data.map((m: any) => ({
                id: `anthropic/${m.id}`,
                name: `Anthropic: ${m.display_name || m.id}`,
                type: 'claude' as const,
                model: m.id,
                apiKey: apiKey,
                url: 'https://api.anthropic.com/v1/messages',
                enabled: true
              }));
            }
          }
        } catch (e) {
          // Fallback on net/CORS error
        }
        if (detected.length === 0) {
          const fallbacks = [
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
            { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' }
          ];
          detected = fallbacks.map(f => ({
            id: `anthropic/${f.id}`,
            name: `Anthropic: ${f.name}`,
            type: 'claude' as const,
            model: f.id,
            apiKey: apiKey,
            url: 'https://api.anthropic.com/v1/messages',
            enabled: true
          }));
        }
      } else if (providerKey === 'openrouter') {
        if (!apiKey) throw new Error('API Key is required.');
        const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models`;
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        const data = await response.json();
        if (data.data && Array.isArray(data.data)) {
          detected = data.data.map((m: any) => ({
            id: `openrouter/${m.id}`,
            name: `OpenRouter: ${m.name || m.id}`,
            type: 'openrouter' as const,
            model: m.id,
            apiKey: apiKey,
            url: `${baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`,
            enabled: true
          }));
        }
      } else if (providerKey === 'ollama') {
        let data: any = null;
        try {
          const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
          if (response.ok) {
            data = await response.json();
          }
        } catch {}
        if (data && data.models && Array.isArray(data.models)) {
          detected = data.models.map((m: any) => ({
            id: `ollama/${m.name}`,
            name: `Ollama: ${m.name}`,
            type: 'local' as const,
            model: m.name,
            url: `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
            enabled: true
          }));
        } else {
          const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`);
          if (!response.ok) throw new Error('Ollama service offline or not reachable.');
          const v1Data = await response.json();
          if (v1Data.data && Array.isArray(v1Data.data)) {
            detected = v1Data.data.map((m: any) => ({
              id: `ollama/${m.id}`,
              name: `Ollama: ${m.id}`,
              type: 'local' as const,
              model: m.id,
              url: `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
              enabled: true
            }));
          }
        }
      } else if (providerKey === 'lmstudio') {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`);
        if (!response.ok) throw new Error('LM Studio service offline or not reachable.');
        const data = await response.json();
        if (data.data && Array.isArray(data.data)) {
          detected = data.data.map((m: any) => ({
            id: `lmstudio/${m.id}`,
            name: `LM Studio: ${m.id}`,
            type: 'openai' as const,
            model: m.id,
            url: `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
            enabled: true
          }));
        }
      } else if (providerKey === 'llama.cpp') {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`);
        if (!response.ok) throw new Error('llama.cpp service offline or not reachable.');
        const data = await response.json();
        if (data.data && Array.isArray(data.data)) {
          detected = data.data.map((m: any) => ({
            id: `llama.cpp/${m.id}`,
            name: `llama.cpp: ${m.id}`,
            type: 'openai' as const,
            model: m.id,
            url: `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
            enabled: true
          }));
        }
      }

      if (detected.length === 0) {
        throw new Error('No models found.');
      }

      setModelsList(prev => {
        const filtered = prev.filter(m => !m.id.startsWith(`${providerKey}/`));
        const merged = [...filtered, ...detected];
        const jsonText = JSON.stringify(merged, null, 2);
        setJsonConfigText(jsonText);
        vscode.postMessage({ type: 'saveLlmConfig', value: jsonText });
        return merged;
      });

      setProviderSyncStatus(prev => ({ ...prev, [providerKey]: `Successfully synced ${detected.length} models!` }));
    } catch (err: any) {
      setProviderSyncStatus(prev => ({ ...prev, [providerKey]: `Error: ${err.message || 'Sync failed.'}` }));
    } finally {
      setSyncingProviders(prev => ({ ...prev, [providerKey]: false }));
    }
  };

  /*
  const toggleSettingsSection = (section: string) => {
    setSettingsExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };
  */

  /*
  const updateProvider = (id: string, field: keyof LLMConfigEntry, value: string | boolean) => {
    setModelsList(prev => {
      const updated = prev.map(m => m.id === id ? { ...m, [field]: value } : m);
      const json = JSON.stringify(updated, null, 2);
      setJsonConfigText(json);
      return updated;
    });
  };

  const saveProviderConfig = () => {
    const json = JSON.stringify(modelsList, null, 2);
    vscode.postMessage({ type: 'saveLlmConfig', value: json });
  };
  */

  const handleResetAllSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    vscode.postMessage({ type: 'saveSettings', value: JSON.stringify(DEFAULT_SETTINGS) });
    setModelsList(DEFAULT_TEMPLATE);
    const templateText = JSON.stringify(DEFAULT_TEMPLATE, null, 2);
    setJsonConfigText(templateText);
    vscode.postMessage({ type: 'saveLlmConfig', value: templateText });
  };

  const handleAttachFile = () => {
    setShowPlusMenu(false);
    vscode.postMessage({ type: 'attachFile' });
  };

  const handleAttachScreenshot = () => {
    setShowPlusMenu(false);
    vscode.postMessage({ type: 'takeScreenshot' });
  };

  const handleMention = () => {
    setShowPlusMenu(false);
    setInputText(prev => prev + '@');
  };

  const removeAttachment = (index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Helper to render formatting and code block elements
  const renderMessageText = (text: string) => {
    if (!text) return null;

    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
      if (part.startsWith('```')) {
        const match = part.match(/```(\w*)\n([\s\S]*?)```/);
        const lang = match ? match[1] : '';
        const code = match ? match[2] : part.slice(3, -3);
        return (
          <div key={index} className="my-2 border border-border rounded-md overflow-hidden bg-panel shadow-sm max-w-full">
            <div className="bg-background px-3 py-1 text-[9px] font-mono border-b border-border flex justify-between items-center text-muted select-none">
              <span className="uppercase font-semibold tracking-wider">{lang || 'code'}</span>
              <button 
                onClick={() => navigator.clipboard.writeText(code)}
                className="hover:text-foreground transition-colors active:scale-95 text-[10px]"
              >
                Copy
              </button>
            </div>
            <pre className="p-2.5 font-mono text-[10px] text-foreground leading-normal select-text whitespace-pre-wrap break-all overflow-x-hidden">
              <code>{code}</code>
            </pre>
          </div>
        );
      }

      const inlineParts = part.split(/(`[^`\n]+`)/g);
      return (
        <span key={index} className="select-text whitespace-pre-wrap break-words max-w-full">
          {inlineParts.map((subPart, subIndex) => {
            if (subPart.startsWith('`') && subPart.endsWith('`')) {
              return (
                <code key={subIndex} className="font-mono bg-panel text-neonPurple px-1 py-0.5 rounded border border-border text-[10px] select-text break-all">
                  {subPart.slice(1, -1)}
                </code>
              );
            }
            return subPart;
          })}
        </span>
      );
    });
  };

  // ─── SETTINGS VIEW ──────────────────────────────────────────────────────────
  const renderSettingsView = () => {
    const sidebarTabs = [
      { id: 'permissions', label: 'Permissions', icon: <svg className="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> },
      { id: 'models', label: 'Models', icon: <svg className="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> },
      { id: 'notifications', label: 'Notifications', icon: <svg className="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg> },
      { id: 'customizations', label: 'Customizations', icon: <svg className="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg> },
      { id: 'browser', label: 'Browser', icon: <svg className="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg> },
      { id: 'tab', label: 'Tab', icon: <svg className="w-[14px] h-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> },
    ] as const;

    return (
      <div className="flex flex-col h-screen text-xs select-none bg-[var(--vscode-editor-background)] text-foreground font-sans overflow-hidden">
        {/* Settings Header */}
        {!(window as any).isSettingsPanel && (
          <div className="flex items-center gap-2.5 px-3 py-2 border-b border-[rgba(255,255,255,0.04)] bg-background select-none shrink-0">
            <button
              onClick={() => setActiveView('chat')}
              className="text-muted/50 hover:text-foreground transition-colors duration-200 cursor-pointer p-0.5"
              title="Back to Chat"
            >
              <BackIcon />
            </button>
            {agentAvatar && (
              <img src={agentAvatar} alt="Black IDE Logo" className="w-3.5 h-3.5 object-contain opacity-60" />
            )}
            <span className="font-medium text-[11.5px] tracking-wide text-muted/70">{activeSettingsTab.charAt(0).toUpperCase() + activeSettingsTab.slice(1)}</span>
          </div>
        )}

        {/* Settings Columns */}
        <div className="flex flex-1 min-h-0 bg-[var(--vscode-editor-background)] overflow-hidden">
          {/* Left Sidebar */}
          <div className="w-[210px] border-r border-[rgba(255,255,255,0.04)] h-full py-5 flex flex-col justify-between shrink-0 select-none overflow-y-auto">
            <div className="flex flex-col">
              {/* Sidebar Header */}
              <div className="flex items-center gap-2.5 px-4 pb-5 mb-2">
                {agentAvatar && (
                  <img src={agentAvatar} alt="Black IDE Logo" className="w-4 h-4 object-contain" />
                )}
                <span className="font-semibold text-[13px] text-foreground tracking-tight">Settings</span>
              </div>
              <div className="flex flex-col gap-0.5 px-2">
                {sidebarTabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveSettingsTab(tab.id)}
                    className={`flex items-center gap-2.5 text-left py-[8px] px-3 transition-all duration-200 text-[12px] cursor-pointer rounded-md ${
                      activeSettingsTab === tab.id
                        ? 'text-foreground font-medium bg-[rgba(255,255,255,0.06)]'
                        : 'text-muted/50 hover:text-foreground/80 hover:bg-[rgba(255,255,255,0.03)]'
                    }`}
                  >
                    <span className={`transition-colors duration-200 ${activeSettingsTab === tab.id ? 'text-foreground/70' : 'text-muted/30'}`}>
                      {tab.icon}
                    </span>
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-4 text-[10px] text-muted/20 font-medium">
              v1.0.0
            </div>
          </div>

          {/* Right Content Panel */}
          <div className="flex-1 h-full p-6 md:p-8 overflow-y-auto bg-[var(--vscode-editor-background)] flex flex-col">
            <div className="max-w-[680px] w-full mx-auto flex flex-col gap-6">
            
            {/* General Tab */}
            {activeSettingsTab === 'general' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">General</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Core settings and data management.</p>
                  </div>
                </div>
                
                <CheckboxRow
                  id="allowAnonymousTelemetry"
                  title="Anonymous Telemetry"
                  description="Allow extension to send anonymous usage data to improve helper features."
                  checked={settings.allowAnonymousTelemetry !== undefined ? settings.allowAnonymousTelemetry : true}
                  onToggle={() => updateSetting('allowAnonymousTelemetry', settings.allowAnonymousTelemetry !== undefined ? !settings.allowAnonymousTelemetry : false)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 118 2.83M22 12A10 10 0 0012 2v10z"/></svg>}
                />

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-red-400/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span className="text-[12px] font-medium text-foreground">Danger Zone</span>
                  </div>
                  <div className="mt-1">
                    <button
                      onClick={handleResetAllSettings}
                      className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-red-400/80 text-[11.5px] font-medium bg-red-500/[0.06] hover:bg-red-500/[0.12] transition-all duration-200 cursor-pointer border border-red-500/10"
                    >
                      <TrashIcon />
                      Reset All Settings
                    </button>
                    <p className="text-[10.5px] text-muted/40 leading-relaxed mt-2">Resets telemetry, autocomplete, and LLM providers to defaults.</p>
                  </div>
                </div>
              </div>
            )}

            {/* Account Tab */}
            {activeSettingsTab === 'account' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Account</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Profile and connection status.</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 py-3 px-4 rounded-xl bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.04)]">
                  <div className="w-10 h-10 rounded-lg bg-[rgba(255,255,255,0.04)] text-foreground/50 font-semibold text-[12px] flex items-center justify-center shadow-inner">
                    DEV
                  </div>
                  <div>
                    <span className="text-[12.5px] font-medium text-foreground block">Developer Mode</span>
                    <span className="text-[11px] text-muted/50 block mt-0.5 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Connected
                    </span>
                    <span className="text-[10px] text-muted/30 mt-1.5 inline-block font-mono bg-[rgba(255,255,255,0.03)] px-2 py-0.5 rounded">Local Workstation</span>
                  </div>
                </div>
              </div>
            )}

            {/* Permissions Tab */}
            {activeSettingsTab === 'permissions' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Permissions</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Agent security profiles, terminal, and filesystem access controls.</p>
                  </div>
                </div>

                {/* Security Profile */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                    <span className="text-[12px] font-medium text-foreground">Security Profile</span>
                  </div>
                  <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Preset preferences that manage filesystem writes, terminal executions, and file creations.</span>
                  
                  <div className="relative">
                    <select
                      value={
                        settings.autoApproveFileEdits && settings.autoApproveTerminal && settings.autoApproveFileCreate
                          ? 'full'
                          : settings.autoApproveFileEdits && !settings.autoApproveTerminal && settings.autoApproveFileCreate
                          ? 'sandbox'
                          : 'strict'
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'full') {
                          updateSetting('autoApproveFileEdits', true);
                          updateSetting('autoApproveTerminal', true);
                          updateSetting('autoApproveFileCreate', true);
                        } else if (val === 'sandbox') {
                          updateSetting('autoApproveFileEdits', true);
                          updateSetting('autoApproveTerminal', false);
                          updateSetting('autoApproveFileCreate', true);
                        } else {
                          updateSetting('autoApproveFileEdits', false);
                          updateSetting('autoApproveTerminal', false);
                          updateSetting('autoApproveFileCreate', false);
                        }
                      }}
                      className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] cursor-pointer appearance-none font-medium transition-all duration-200"
                    >
                      <option value="full" className="bg-background text-foreground">Full Access — Auto-approves terminal and file edits</option>
                      <option value="sandbox" className="bg-background text-foreground">Sandboxed — Auto-approves file edits, prompts terminal</option>
                      <option value="strict" className="bg-background text-foreground">Strict — Prompts for all writes and terminal commands</option>
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted/30">
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
                    </div>
                  </div>
                </div>

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* Terminal */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                    <span className="text-[11px] text-muted font-medium uppercase tracking-wider opacity-50">Terminal</span>
                  </div>
                    
                  <div className="flex flex-col gap-2.5">
                    <div>
                      <span className="text-[12px] font-medium text-foreground block">Command Auto Execution</span>
                      <span className="text-[11px] text-muted/50 leading-relaxed block mt-0.5">Execute terminal commands automatically without confirmation.</span>
                    </div>
                    <div className="relative">
                      <select
                        value={settings.autoApproveTerminal ? 'auto' : 'request'}
                        onChange={(e) => updateSetting('autoApproveTerminal', e.target.value === 'auto')}
                        className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] cursor-pointer appearance-none font-medium transition-all duration-200"
                      >
                        <option value="request" className="bg-background text-foreground">Request Review</option>
                        <option value="auto" className="bg-background text-foreground">Auto Execute</option>
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted/30">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
                      </div>
                    </div>
                  </div>

                  <CheckboxRow
                    id="enableShellIntegration"
                    title="Shell Integration"
                    description="Forward active shell processes for enhanced command execution status."
                    checked={settings.autoApproveTerminal}
                    onToggle={() => updateSetting('autoApproveTerminal', !settings.autoApproveTerminal)}
                    icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
                  />
                </div>

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* File System */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    <span className="text-[11px] text-muted font-medium uppercase tracking-wider opacity-50">File System</span>
                  </div>

                  <CheckboxRow
                    id="nonWorkspaceAccess"
                    title="Non-Workspace File Access"
                    description="Allow the agent to view files outside the current project root."
                    checked={settings.autoApproveFileCreate}
                    onToggle={() => updateSetting('autoApproveFileCreate', !settings.autoApproveFileCreate)}
                    icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/><path d="M14 11a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.71 1.71"/></svg>}
                  />

                  <CheckboxRow
                    id="autoOpenEditedFiles"
                    title="Auto-Open Edited Files"
                    description="Open files edited by the agent in editor tabs automatically."
                    checked={settings.autoApproveFileEdits}
                    onToggle={() => updateSetting('autoApproveFileEdits', !settings.autoApproveFileEdits)}
                    icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>}
                  />
                </div>
              </div>
            )}

            {/* Appearance Tab */}
            {activeSettingsTab === 'appearance' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 18a6 6 0 100-12v12z"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Appearance</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Visual preferences and accessibility.</p>
                  </div>
                </div>
                
                <CheckboxRow
                  id="largeFontSize"
                  title="Large Font Size"
                  description="Increase UI and text font size for better accessibility."
                  checked={false}
                  onToggle={() => {}}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>}
                />
              </div>
            )}

            {/* Notifications Tab */}
            {activeSettingsTab === 'notifications' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Notifications</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Alert and notification preferences.</p>
                  </div>
                </div>

                <CheckboxRow
                  id="taskCompletionAlerts"
                  title="Task Completion Alerts"
                  description="Notify when background agent loop processes finish execution."
                  checked={true}
                  onToggle={() => {}}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
                />
              </div>
            )}

            {/* Models Tab */}
            {activeSettingsTab === 'models' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                {/* Header */}
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  </div>
                  <div className="flex flex-col gap-1 flex-1 min-w-0">
                    <div className="flex justify-between items-center">
                      <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Models</h3>
                      <button
                        onClick={() => {
                          setJsonEditText(_jsonConfigText);
                          setShowJsonConfigModal(true);
                        }}
                        className="text-[11px] text-muted hover:text-foreground font-medium bg-transparent border-0 cursor-pointer flex items-center gap-1.5 transition-colors duration-200 opacity-60 hover:opacity-100"
                      >
                        <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                        </svg>
                        Edit JSON
                      </button>
                    </div>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Configure model providers and select your active agent model.</p>
                  </div>
                </div>

                {/* Active model selector */}
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-[12px] font-medium text-foreground">Active Model</span>
                  </div>
                  <div className="relative w-full">
                    <select
                      value={selectedModelId}
                      onChange={(e) => {
                        setSelectedModelId(e.target.value);
                        updateSetting('selectedModelId', e.target.value);
                      }}
                      className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] cursor-pointer appearance-none font-medium transition-all duration-200"
                    >
                      {modelsList.length === 0 ? (
                        <option value="">No models configured</option>
                      ) : (
                        Object.entries(groupModels(modelsList)).map(([groupName, groupModels]) => {
                          if (groupModels.length === 0) return null;
                          return (
                            <optgroup key={groupName} label={groupName} className="bg-background text-foreground font-semibold">
                              {groupModels.map(model => (
                                <option key={model.id} value={model.id} className="bg-background text-foreground font-normal">
                                  {model.name}
                                </option>
                              ))}
                            </optgroup>
                          );
                        })
                      )}
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted opacity-40">
                      <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                        <path d="M7 10l5 5 5-5z" />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* Divider */}
                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* Provider Connection */}
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/><path d="M14 11a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.71 1.71"/></svg>
                    <span className="text-[12px] font-medium text-foreground">Connect Provider</span>
                  </div>
                  
                  {/* Provider Select */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-muted font-medium uppercase tracking-wider opacity-50">Provider</span>
                    <div className="relative w-full">
                      <select
                        value={connectProvider}
                        onChange={(e) => setConnectProvider(e.target.value)}
                        className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] cursor-pointer appearance-none font-medium transition-all duration-200"
                      >
                        {Object.entries(PROVIDER_NAMES).map(([key, name]) => (
                          <option key={key} value={key} className="bg-background text-foreground">
                            {name}
                          </option>
                        ))}
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted opacity-40">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M7 10l5 5 5-5z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {/* API Key */}
                  {!['ollama', 'lmstudio', 'llama.cpp'].includes(connectProvider) && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[11px] text-muted font-medium uppercase tracking-wider opacity-50">API Key</span>
                      <div className="relative w-full">
                        <input
                          type={providerPasswordVisible[connectProvider] ? 'text' : 'password'}
                          value={connectApiKey}
                          onChange={(e) => setConnectApiKey(e.target.value)}
                          placeholder={`Enter API Key for ${PROVIDER_NAMES[connectProvider]}`}
                          className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none pl-3 pr-14 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-mono transition-all duration-200 placeholder:text-muted/40"
                        />
                        <button
                          onClick={() => setProviderPasswordVisible(prev => ({ ...prev, [connectProvider]: !prev[connectProvider] }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted hover:text-foreground font-medium bg-transparent border-0 cursor-pointer px-1.5 py-0.5 rounded transition-colors duration-150 opacity-60 hover:opacity-100"
                        >
                          {providerPasswordVisible[connectProvider] ? 'Hide' : 'Show'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Base URL */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-muted font-medium uppercase tracking-wider opacity-50">Base URL</span>
                    <input
                      type="text"
                      value={connectBaseUrl}
                      onChange={(e) => setConnectBaseUrl(e.target.value)}
                      placeholder="E.g. https://api.openai.com"
                      className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-mono transition-all duration-200 placeholder:text-muted/40"
                    />
                  </div>

                  {/* Fetch Button */}
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      disabled={isFetchingModels}
                      onClick={fetchModelsFromProvider}
                      className="group/btn relative bg-gradient-to-r from-[var(--vscode-focusBorder,#007fd4)] to-[#6366f1] text-white px-5 py-2.5 rounded-lg font-semibold text-[11.5px] transition-all duration-300 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2.5 active:scale-[0.96] border-0 shadow-[0_2px_12px_rgba(99,102,241,0.25)] hover:shadow-[0_4px_20px_rgba(99,102,241,0.35)] hover:brightness-110"
                    >
                      {isFetchingModels ? (
                        <>
                          <div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                          Fetching Models…
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5 fill-current transition-transform duration-300 group-hover/btn:translate-y-[1px]" viewBox="0 0 24 24">
                            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                          </svg>
                          Fetch Models
                        </>
                      )}
                    </button>

                    {fetchError && (
                      <span className="text-[11px] text-red-400/80 font-medium">
                        {fetchError}
                      </span>
                    )}
                  </div>
                </div>

                {/* Divider */}
                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* Added Models */}
                <div className="flex flex-col gap-4">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[12px] font-medium text-foreground">Added Models</span>
                      <span className="text-[10px] font-medium text-muted/50 tabular-nums">
                        {modelsList.length}
                      </span>
                    </div>
                  </div>
                  
                  {modelsList.length === 0 ? (
                    <div className="text-center py-10 text-muted/40 text-[11.5px] font-medium">
                      No models configured yet
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {modelsList.map((model) => {
                        const providerId = model.id.split('/')[0];
                        const providerName = PROVIDER_NAMES[providerId] || model.type;
                        const isCurrentlyActive = model.id === selectedModelId;
                        
                        // Minimal provider accent colors
                        let accentColor = 'rgba(255,255,255,0.5)';
                        let providerLetter = providerName.charAt(0).toUpperCase();
                        if (providerId === 'google') {
                          accentColor = '#818cf8';
                        } else if (providerId === 'openai') {
                          accentColor = '#34d399';
                        } else if (providerId === 'anthropic' || providerId === 'claude') {
                          accentColor = '#fbbf24';
                        } else if (providerId === 'openrouter') {
                          accentColor = '#a78bfa';
                        }
                        
                        return (
                          <div 
                            key={model.id}
                            className={`group relative flex items-start gap-3 p-3.5 rounded-lg transition-all duration-200 cursor-default ${
                              isCurrentlyActive 
                                ? 'bg-[rgba(255,255,255,0.06)] animate-pulse-subtle' 
                                : 'bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(255,255,255,0.05)]'
                            }`}
                          >
                            {/* Provider Indicator */}
                            <div 
                              className="w-8 h-8 rounded-lg flex items-center justify-center font-semibold text-[12px] shrink-0"
                              style={{ 
                                backgroundColor: `${accentColor}15`,
                                color: accentColor
                              }}
                            >
                              {providerLetter}
                            </div>
                            
                            {/* Model Info */}
                            <div className="flex-1 min-w-0 pr-6">
                              <span className="text-[12px] font-medium text-foreground block truncate" title={model.name}>
                                {model.name}
                              </span>
                              <span className="text-[10px] text-muted/50 font-mono block truncate mt-0.5" title={model.model}>
                                {model.model}
                              </span>
                              <div className="flex items-center gap-1.5 mt-2">
                                <span className="text-[9.5px] text-muted/40 font-medium">
                                  {providerName}
                                </span>
                                {isCurrentlyActive && (
                                  <span className="text-[9px] font-medium text-emerald-400/70 flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                    Active
                                  </span>
                                )}
                              </div>
                            </div>
                            
                            {/* Delete */}
                            <button
                              onClick={() => {
                                setModelsList(prev => {
                                  const updated = prev.filter(m => m.id !== model.id);
                                  const json = JSON.stringify(updated, null, 2);
                                  setJsonConfigText(json);
                                  vscode.postMessage({ type: 'saveLlmConfig', value: json });
                                  
                                  if (selectedModelId === model.id) {
                                    const fallback = updated[0]?.id || '';
                                    setSelectedModelId(fallback);
                                    updateSetting('selectedModelId', fallback);
                                  }
                                  return updated;
                                });
                              }}
                              title="Remove"
                              className="absolute right-2.5 top-2.5 p-1 rounded text-muted/30 hover:text-red-400/70 transition-all duration-150 border-0 bg-transparent opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Customizations Tab */}
            {activeSettingsTab === 'customizations' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Customizations</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Agent behavior, loop limits, and prompt customization.</p>
                  </div>
                </div>
                
                {/* Loop Iterations */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>
                    <span className="text-[12px] font-medium text-foreground block">Max Loop Iterations</span>
                  </div>
                  <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Max steps (1–500) an agent can execute recursively before stopping.</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={settings.maxLoopIterations}
                    onChange={(e) => updateSetting('maxLoopIterations', Math.min(500, Math.max(1, parseInt(e.target.value) || 25)))}
                    className="w-20 bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] text-center font-medium transition-all duration-200"
                  />
                </div>

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                <CheckboxRow
                  id="enableFastApply"
                  title="Fast Apply"
                  description="Use search/replace delta modifications to speed up file editing operations."
                  checked={settings.enableFastApply}
                  onToggle={() => updateSetting('enableFastApply', !settings.enableFastApply)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>}
                />

                <CheckboxRow
                  id="enableReasoningDisplay"
                  title="Show Reasoning"
                  description="Display thought bubbles showing internal reasoning steps."
                  checked={settings.enableReasoningDisplay}
                  onToggle={() => updateSetting('enableReasoningDisplay', !settings.enableReasoningDisplay)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>}
                />

                <CheckboxRow
                  id="pipelineAutoOpenAllFiles"
                  title="Auto-Open All Pipeline Files"
                  description="Open every file the multi-agent pipeline creates or modifies in a preview tab. Off by default to avoid flooding the tab bar."
                  checked={settings.pipelineAutoOpenAllFiles}
                  onToggle={() => updateSetting('pipelineAutoOpenAllFiles', !settings.pipelineAutoOpenAllFiles)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>}
                />

                <CheckboxRow
                  id="pipelineParallelExecution"
                  title="Parallel Phase Execution (experimental)"
                  description="Run independent phases (e.g. design and backend) at the same time in separate git worktrees, then merge their changes. Faster on multi-phase plans, but newer and less tested than the default sequential path — leave off unless you want to try it."
                  checked={settings.pipelineParallelExecution}
                  onToggle={() => updateSetting('pipelineParallelExecution', !settings.pipelineParallelExecution)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>}
                />

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* Per-run token budget */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                    <span className="text-[12px] font-medium text-foreground block">Pipeline Token Budget</span>
                  </div>
                  <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">
                    Stop a pipeline run once its cumulative (input + output) tokens exceed this ceiling — a guardrail against a runaway multi-agent run. 0 = unlimited.
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={settings.pipelineTokenBudget}
                    onChange={(e) => updateSetting('pipelineTokenBudget', Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-32 bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-medium transition-all duration-200"
                  />
                </div>

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* What a finished run does with its work */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/></svg>
                    <span className="text-[12px] font-medium text-foreground block">Pipeline Output Mode</span>
                  </div>
                  <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">
                    <strong>Apply to workspace</strong> merges a completed run's changes into your working tree. <strong>Open a pull request</strong> leaves the work on its own branch and pushes it for review instead — your working tree is never touched.
                  </span>
                  <select
                    value={settings.pipelineOutputMode}
                    onChange={(e) => updateSetting('pipelineOutputMode', e.target.value as 'apply' | 'pr')}
                    className="w-56 bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-medium transition-all duration-200"
                  >
                    <option value="apply">Apply to workspace (default)</option>
                    <option value="pr">Open a pull request</option>
                  </select>
                </div>

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* Per-phase pipeline model assignment */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                    <span className="text-[12px] font-medium text-foreground block">Pipeline Phase Models</span>
                  </div>
                  <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">
                    Assign a different model per pipeline phase — e.g. a cheaper/faster model for HLD/LLD scaffolding, a stronger one for execution. Leave as default to use the model selected for the chat.
                  </span>
                  {['Sr Architect HLD', 'Sr Engineer LLD', 'Planner', 'Design Executor', 'Backend Executor', 'Frontend Executor', 'Testing Executor'].map(phaseName => (
                    <div key={phaseName} className="flex items-center gap-3">
                      <span className="text-[11px] text-muted/70 w-[140px] shrink-0 truncate" title={phaseName}>{phaseName}</span>
                      <div className="relative flex-1">
                        <select
                          value={settings.pipelinePhaseModels[phaseName] || ''}
                          onChange={(e) => updateSetting('pipelinePhaseModels', { ...settings.pipelinePhaseModels, [phaseName]: e.target.value })}
                          className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-1.5 text-[11.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] cursor-pointer appearance-none font-medium transition-all duration-200"
                        >
                          <option value="" className="bg-background text-foreground">(use pipeline default)</option>
                          {modelsList.map(model => (
                            <option key={model.id} value={model.id} className="bg-background text-foreground">
                              {model.name}
                            </option>
                          ))}
                        </select>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted opacity-40">
                          <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
                            <path d="M7 10l5 5 5-5z" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                {/* Custom System Prompt */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                    <span className="text-[12px] font-medium text-foreground block">Custom System Prompt</span>
                  </div>
                  <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Override or augment the default system prompt for AI agents.</span>
                  <textarea
                    value={settings.customSystemPrompt}
                    onChange={(e) => updateSetting('customSystemPrompt', e.target.value)}
                    placeholder="Enter custom instructions or context..."
                    rows={4}
                    className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] leading-relaxed resize-y font-mono transition-all duration-200 placeholder:text-muted/30"
                  />
                </div>
              </div>
            )}

            {/* Browser Tab */}
            {activeSettingsTab === 'browser' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Browser</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Browser automation, viewport, and navigation controls.</p>
                  </div>
                </div>
                
                <CheckboxRow
                  id="browserEnabled"
                  title="Enable Browser Driver"
                  description="Allow agents to start and orchestrate browser tools for testing and scraping."
                  checked={settings.browserEnabled}
                  onToggle={() => updateSetting('browserEnabled', !settings.browserEnabled)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>}
                />

                {/* One-time browser runtime install. Playwright is not bundled, so the
                    browser tools stay hidden until this installs it (Option B). */}
                <div className="flex items-center justify-between gap-3 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-3.5 py-3">
                  <span className="text-[11px] text-muted/70 leading-relaxed">
                    Browser tools need a one-time runtime install (Playwright + Chromium). They stay disabled until it's installed.
                  </span>
                  <button
                    onClick={() => vscode.postMessage({ type: 'installBrowserSupport' })}
                    className="shrink-0 bg-[rgba(255,255,255,0.05)] hover:bg-[rgba(255,255,255,0.08)] text-foreground text-[11px] font-medium px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.08)] transition-all duration-200 cursor-pointer active:scale-[0.97]"
                  >
                    Install browser support
                  </button>
                </div>

                <div className={`flex flex-col gap-8 transition-opacity duration-300 ${!settings.browserEnabled ? 'opacity-20 pointer-events-none' : ''}`}>
                  <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                  {/* Path */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                      <span className="text-[12px] font-medium text-foreground block">Executable Path</span>
                    </div>
                    <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Absolute path to browser executable (e.g. Chrome, Chromium).</span>
                    <input
                      type="text"
                      value={settings.browserPath}
                      onChange={(e) => updateSetting('browserPath', e.target.value)}
                      placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                      className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-mono transition-all duration-200 placeholder:text-muted/30"
                    />
                  </div>

                  <CheckboxRow
                    id="browserHeadless"
                    title="Headless Mode"
                    description="Start browser in the background without layout window frame."
                    checked={settings.browserHeadless}
                    onToggle={() => updateSetting('browserHeadless', !settings.browserHeadless)}
                    icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>}
                  />

                  {/* Viewport */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
                      <span className="text-[11px] text-muted font-medium uppercase tracking-wider opacity-50">Viewport</span>
                    </div>
                    <div className="flex gap-6 w-full">
                      <div className="flex-1 flex flex-col gap-1.5">
                        <span className="text-[11px] text-muted/50 font-medium">Width</span>
                        <input
                          type="number"
                          value={settings.browserViewportWidth}
                          onChange={(e) => updateSetting('browserViewportWidth', parseInt(e.target.value) || 1280)}
                          className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-medium transition-all duration-200"
                        />
                      </div>
                      <div className="flex-1 flex flex-col gap-1.5">
                        <span className="text-[11px] text-muted/50 font-medium">Height</span>
                        <input
                          type="number"
                          value={settings.browserViewportHeight}
                          onChange={(e) => updateSetting('browserViewportHeight', parseInt(e.target.value) || 720)}
                          className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-medium transition-all duration-200"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                  {/* Allowed domains */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                      <span className="text-[12px] font-medium text-foreground block">Allowed Domains</span>
                    </div>
                    <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Restricts browser navigation to these domains (one per line).</span>
                    <textarea
                      value={settings.browserAllowedDomains}
                      onChange={(e) => updateSetting('browserAllowedDomains', e.target.value)}
                      placeholder={"github.com\nstackoverflow.com"}
                      rows={2}
                      className="w-full bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] font-mono resize-y transition-all duration-200 placeholder:text-muted/30"
                    />
                  </div>

                  <CheckboxRow
                    id="browserScreenshotOnNav"
                    title="Screenshot on Navigation"
                    description="Capture page snapshots after each URL navigation automatically."
                    checked={settings.browserScreenshotOnNav}
                    onToggle={() => updateSetting('browserScreenshotOnNav', !settings.browserScreenshotOnNav)}
                    icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>}
                  />
                </div>
              </div>
            )}

            {/* Tab Tab */}
            {activeSettingsTab === 'tab' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Tab Autocomplete</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Inline code completion settings.</p>
                  </div>
                </div>
                
                <CheckboxRow
                  id="enableAutocomplete"
                  title="Enable Autocomplete"
                  description="Show inline autocomplete suggestions inside text editors."
                  checked={settings.enableAutocomplete}
                  onToggle={() => updateSetting('enableAutocomplete', !settings.enableAutocomplete)}
                  icon={<svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>}
                />

                <div className={`flex flex-col gap-8 transition-opacity duration-300 ${!settings.enableAutocomplete ? 'opacity-20 pointer-events-none' : ''}`}>
                  <div className="h-px bg-[rgba(255,255,255,0.04)]" />

                  {/* Autocomplete model */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
                      <span className="text-[12px] font-medium text-foreground block">Completion Model</span>
                    </div>
                    <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Select the model used for inline completions.</span>
                    <div className="relative">
                      <select
                        value={settings.autocompleteModelId || settings.selectedModelId || ''}
                        onChange={(e) => updateSetting('autocompleteModelId', e.target.value)}
                        className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2.5 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] cursor-pointer appearance-none font-medium transition-all duration-200"
                      >
                        {modelsList.map(model => (
                          <option key={model.id} value={model.id} className="bg-background text-foreground">
                            {model.name}
                          </option>
                        ))}
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted opacity-40">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M7 10l5 5 5-5z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {/* Debounce */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-muted/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      <span className="text-[12px] font-medium text-foreground block">Trigger Delay</span>
                    </div>
                    <span className="text-[11px] text-muted/50 leading-relaxed block -mt-1">Debounce delay in milliseconds before completions trigger.</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={50}
                        max={2000}
                        value={settings.autocompleteDebounce !== undefined ? settings.autocompleteDebounce : 250}
                        onChange={(e) => updateSetting('autocompleteDebounce', Math.min(2000, Math.max(50, parseInt(e.target.value) || 250)))}
                        className="w-20 bg-[rgba(255,255,255,0.04)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none px-3 py-2 text-[12.5px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] text-center font-medium transition-all duration-200"
                      />
                      <span className="text-[10px] text-muted/30 font-medium">ms</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Editor Tab */}
            {activeSettingsTab === 'editor' && (
              <div className="flex flex-col gap-8 animate-fade-in">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[rgba(255,255,255,0.03)] to-[rgba(255,255,255,0.08)] border border-[rgba(255,255,255,0.05)] text-foreground/70 flex items-center justify-center shrink-0 shadow-lg">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[18px] font-medium text-foreground tracking-[-0.01em]">Editor</h3>
                    <p className="text-muted text-[11.5px] leading-relaxed opacity-70">Configuration reference for debugging.</p>
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <span className="text-[12px] font-medium text-foreground">Model Configuration JSON</span>
                  <pre className="w-full bg-[rgba(255,255,255,0.03)] p-4 rounded-lg font-mono text-[10.5px] select-text overflow-x-auto max-h-[360px] leading-relaxed text-foreground/60 whitespace-pre border-0">
                    {_jsonConfigText}
                  </pre>
                </div>
              </div>
            )}

            </div>
          </div>
        </div>

        {showJsonConfigModal && (
          <div className="fixed inset-0 bg-background/70 backdrop-blur-lg z-50 flex items-center justify-center p-2 sm:p-4">
            <div className="w-full max-w-[600px] bg-gradient-to-b from-[var(--vscode-editor-background,#1e1e1e)] to-[rgba(30,30,30,0.95)] border border-[rgba(255,255,255,0.08)] rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col max-h-[90%] select-text animate-slide-up">
              <div className="flex justify-between items-center px-4 sm:px-5 py-3.5 border-b border-[rgba(255,255,255,0.04)] bg-background/20 select-none">
                <span className="font-semibold text-[12.5px] sm:text-[13.5px] text-foreground tracking-tight">Edit Configuration</span>
                <button
                  onClick={() => setShowJsonConfigModal(false)}
                  className="text-muted/40 hover:text-foreground hover:bg-foreground/5 transition-colors p-1.5 rounded-full cursor-pointer border-0 bg-transparent flex items-center justify-center shrink-0"
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              </div>
              <div className="p-4 sm:p-5 flex-1 overflow-y-auto flex flex-col gap-3 min-h-0">
                <span className="text-[11px] text-muted/40 leading-relaxed select-none">
                  Raw JSON array of model configurations. Changes are applied immediately.
                </span>
                <textarea
                  value={jsonEditText}
                  onChange={(e) => setJsonEditText(e.target.value)}
                  className="flex-1 w-full min-h-[150px] bg-[rgba(255,255,255,0.03)] text-foreground/80 rounded-lg p-3 sm:p-4 text-[11px] font-mono leading-relaxed border border-[rgba(255,255,255,0.06)] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] transition-all duration-200 placeholder:text-muted/20"
                  placeholder="[ ... ]"
                />
              </div>
              <div className="px-4 sm:px-5 py-3 border-t border-[rgba(255,255,255,0.04)] flex flex-wrap justify-end gap-2 shrink-0 select-none">
                <button
                  onClick={() => setShowJsonConfigModal(false)}
                  className="bg-transparent text-foreground hover:bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.1)] px-4 py-1.5 rounded-lg font-semibold text-[11.5px] cursor-pointer transition-all duration-200"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(jsonEditText);
                      if (!Array.isArray(parsed)) {
                        alert('Configuration must be a JSON array of model configurations.');
                        return;
                      }
                      setModelsList(parsed);
                      setJsonConfigText(jsonEditText);
                      vscode.postMessage({ type: 'saveLlmConfig', value: jsonEditText });
                      setShowJsonConfigModal(false);
                    } catch (err: any) {
                      alert(`Invalid JSON format: ${err.message || 'Check your syntax.'}`);
                    }
                  }}
                  className="bg-gradient-to-r from-[var(--vscode-focusBorder,#007fd4)] to-[#6366f1] text-white px-4 py-1.5 rounded-lg font-semibold text-[11.5px] cursor-pointer transition-all duration-200 border-0 hover:brightness-110 shadow-[0_2px_8px_rgba(99,102,241,0.2)]"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}

        {showModelSelectionPopup && (
          <div className="fixed inset-0 bg-[var(--vscode-editor-background)]/75 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4">
            <div className="w-full max-w-[480px] bg-gradient-to-b from-[var(--vscode-editor-background,#1e1e1e)] to-[rgba(30,30,30,0.95)] border border-[rgba(255,255,255,0.08)] rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col max-h-[85%] select-none animate-slide-up">
              <div className="flex justify-between items-center px-4 py-3.5 border-b border-[rgba(255,255,255,0.04)] bg-background/20 select-none">
                <span className="font-semibold text-[12.5px] sm:text-[13.5px] text-foreground tracking-tight truncate">Select Models to Add</span>
                <button
                  onClick={() => setShowModelSelectionPopup(false)}
                  className="text-muted hover:text-foreground hover:bg-foreground/5 transition-colors p-1.5 rounded-full cursor-pointer border-0 bg-transparent shrink-0 flex items-center justify-center"
                >
                  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              </div>
              
              <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-3 min-h-0">
                <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2 text-[10.5px] text-muted/70 font-sans border-b border-[rgba(255,255,255,0.04)] pb-2 uppercase tracking-wider font-semibold">
                  <span className="truncate">Available models for {PROVIDER_NAMES[connectProvider] || connectProvider}</span>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => {
                        const allIds = new Set(fetchedModelsList.map(m => m.id));
                        setSelectedModelIdsToSave(allIds);
                      }}
                      className="text-[var(--vscode-textLink-foreground,#007fd4)] hover:underline bg-transparent border-0 cursor-pointer font-bold p-0 text-[10.5px]"
                    >
                      Select All
                    </button>
                    <span className="text-[rgba(255,255,255,0.15)]">|</span>
                    <button
                      onClick={() => {
                        setSelectedModelIdsToSave(new Set());
                      }}
                      className="text-[var(--vscode-textLink-foreground,#007fd4)] hover:underline bg-transparent border-0 cursor-pointer font-bold p-0 text-[10.5px]"
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                {/* Search / Filter Input */}
                <div className="relative w-full shrink-0">
                  <input
                    type="text"
                    value={modelFilterText}
                    onChange={(e) => setModelFilterText(e.target.value)}
                    placeholder="Search models..."
                    className="w-full bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)] text-foreground border-0 border-b border-[rgba(255,255,255,0.08)] rounded-none pl-9 pr-8 py-2.5 text-[12px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)] transition-all duration-200 placeholder:text-muted/30 font-sans"
                  />
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted opacity-40">
                    <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  {modelFilterText && (
                    <button
                      onClick={() => setModelFilterText('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground bg-transparent border-0 cursor-pointer p-0.5 rounded-full"
                    >
                      <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Model Cards List */}
                <div className="flex flex-col gap-2 overflow-y-auto pr-1 min-h-0 flex-1">
                  {fetchedModelsList.filter(model =>
                    model.name.toLowerCase().includes(modelFilterText.toLowerCase()) ||
                    model.model?.toLowerCase().includes(modelFilterText.toLowerCase())
                  ).map((model) => {
                    const isChecked = selectedModelIdsToSave.has(model.id);
                    const providerId = model.id.split('/')[0];
                    const providerName = PROVIDER_NAMES[providerId] || model.type || 'model';
                    const providerLetter = providerName.charAt(0).toUpperCase();
                    
                    let accentColor = 'rgba(255,255,255,0.5)';
                    if (providerId === 'google') {
                      accentColor = '#818cf8';
                    } else if (providerId === 'openai') {
                      accentColor = '#34d399';
                    } else if (providerId === 'anthropic' || providerId === 'claude') {
                      accentColor = '#fbbf24';
                    } else if (providerId === 'openrouter') {
                      accentColor = '#a78bfa';
                    }

                    return (
                      <div
                        key={model.id}
                        onClick={() => {
                          setSelectedModelIdsToSave(prev => {
                            const next = new Set(prev);
                            if (next.has(model.id)) {
                              next.delete(model.id);
                            } else {
                              next.add(model.id);
                            }
                            return next;
                          });
                        }}
                        className={`flex items-center gap-3.5 p-3 rounded-lg transition-all duration-200 cursor-pointer ${
                          isChecked 
                            ? 'bg-[rgba(255,255,255,0.06)]' 
                            : 'bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(255,255,255,0.05)]'
                        }`}
                      >
                        {/* Provider Indicator Icon */}
                        <div 
                          className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[12px] shrink-0 transition-all duration-200"
                          style={{ 
                            backgroundColor: isChecked ? `${accentColor}25` : `${accentColor}12`,
                            color: accentColor
                          }}
                        >
                          {providerLetter}
                        </div>

                        {/* Model details */}
                        <div className="flex-1 min-w-0">
                          <span className="text-[12px] font-semibold text-foreground block truncate font-sans">{model.name}</span>
                          <span className="text-[10px] text-muted/50 font-mono block truncate mt-0.5">{model.model}</span>
                        </div>

                        {/* Selection Checkmark on the right */}
                        <div className="w-5 h-5 flex items-center justify-center shrink-0">
                          {isChecked && (
                            <svg className="w-4 h-4 stroke-[var(--vscode-focusBorder,#007fd4)] fill-none stroke-[2.5] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {fetchedModelsList.filter(model =>
                    model.name.toLowerCase().includes(modelFilterText.toLowerCase()) ||
                    model.model?.toLowerCase().includes(modelFilterText.toLowerCase())
                  ).length === 0 && (
                    <div className="text-center py-8 text-muted italic text-[11px] font-sans">
                      No models matching search query.
                    </div>
                  )}
                </div>
              </div>

              <div className="px-4 py-3 bg-background/30 border-t border-[rgba(255,255,255,0.04)] flex flex-wrap justify-end gap-2 shrink-0 select-none">
                <button
                  onClick={() => setShowModelSelectionPopup(false)}
                  className="bg-transparent text-foreground hover:bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.1)] px-4 py-1.5 rounded-lg font-semibold text-[11.5px] cursor-pointer transition-all duration-200"
                >
                  Cancel
                </button>
                <button
                  disabled={selectedModelIdsToSave.size === 0}
                  onClick={() => {
                    const modelsToAdd = fetchedModelsList.filter(m => selectedModelIdsToSave.has(m.id));
                    setModelsList(prev => {
                      const existingIds = new Set(prev.map(m => m.id));
                      const filteredNew = modelsToAdd.filter(m => !existingIds.has(m.id));
                      const updated = [...prev, ...filteredNew];
                      const json = JSON.stringify(updated, null, 2);
                      setJsonConfigText(json);
                      vscode.postMessage({ type: 'saveLlmConfig', value: json });
                      
                      if (!selectedModelId && updated.length > 0) {
                        const defaultId = updated[0].id;
                        setSelectedModelId(defaultId);
                        updateSetting('selectedModelId', defaultId);
                      }
                      return updated;
                    });
                    setShowModelSelectionPopup(false);
                  }}
                  className="bg-gradient-to-r from-[var(--vscode-focusBorder,#007fd4)] to-[#6366f1] text-white px-4 py-1.5 rounded-lg font-semibold text-[11.5px] cursor-pointer transition-all duration-200 border-0 hover:brightness-110 shadow-[0_2px_8px_rgba(99,102,241,0.2)] disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none"
                >
                  Add Selected ({selectedModelIdsToSave.size})
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ─── MAIN CHAT VIEW ────────────────────────────────────────────────────────
  if (activeView === 'settings') {
    return renderSettingsView();
  }

  return (
    <div className="flex flex-col h-screen text-xs select-none bg-background text-foreground font-sans overflow-x-hidden relative">
      {/* History Drawer Overlay */}
      {showHistoryDrawer && (
        <div 
          onClick={() => setShowHistoryDrawer(false)}
          className="absolute inset-0 bg-background/50 backdrop-blur-sm z-40 flex justify-end"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="w-[85%] max-w-[280px] bg-panel border-l border-border h-full flex flex-col shadow-2xl animate-slide-left select-none"
          >
            <div className="flex justify-between items-center px-3 py-2.5 border-b border-border bg-background">
              <span className="font-semibold text-foreground text-[11px]">Conversations</span>
              <button
                onClick={handleNewChat}
                className="text-[9px] bg-buttonBg text-buttonFg px-2 py-1 rounded-md hover:bg-buttonHoverBg transition-all cursor-pointer font-semibold uppercase tracking-wider"
              >
                + New Chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1 min-h-0">
              {historyThreads.length === 0 ? (
                <div className="text-center text-muted text-[10px] py-6 italic">No past conversations.</div>
              ) : (
                historyThreads.map((thread) => (
                  <div
                    key={thread.id}
                    onClick={() => handleSelectThread(thread)}
                    className={`group flex justify-between items-center px-2.5 py-1.5 rounded-md cursor-pointer transition-all ${
                      activeThreadId === thread.id
                        ? 'bg-focusBorder/15 text-foreground font-semibold'
                        : 'text-muted hover:text-foreground hover:bg-background/80'
                    }`}
                  >
                    <span className="truncate text-[11px] max-w-[85%] font-medium">{thread.title || 'Conversation'}</span>
                    <button
                      onClick={(e) => handleDeleteThread(thread.id, e)}
                      className="text-muted hover:text-dangerRed p-0.5 rounded hover:bg-panel transition-all cursor-pointer opacity-0 group-hover:opacity-100 flex items-center justify-center"
                      title="Delete thread"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Header Bar — Show conversation's title or "Black Agent" */}
      <div className="flex justify-between items-center px-3 py-2.5 border-b border-border bg-background select-none">
        <div className="flex items-center">
          <span className="font-semibold text-[11.5px] tracking-wide text-foreground">
            {historyThreads.find((t) => t.id === activeThreadId)?.title || 'Black Agent'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
            className="text-muted hover:text-foreground p-1 rounded hover:bg-panel cursor-pointer transition-colors"
            title="Chat History"
          >
            <HistoryIcon />
          </button>
          <div className="relative" ref={settingsMenuRef}>
            <button
              onClick={() => setShowSettingsDropdown(!showSettingsDropdown)}
              className="text-muted hover:text-foreground p-1 rounded hover:bg-panel cursor-pointer transition-colors flex items-center justify-center"
              title="Settings & Actions"
            >
              <SettingsIcon />
            </button>
            {showSettingsDropdown && (
              <div className="absolute right-0 top-[calc(100%+6px)] bg-panel border border-border rounded-md shadow-lg py-1 min-w-[145px] z-50 text-left overflow-hidden animate-slide-up">
                <button
                  onClick={() => {
                    if (!rawVscode) {
                      setActiveView('settings');
                    } else {
                      vscode.postMessage({ type: 'openSettingsPanel' });
                    }
                    setShowSettingsDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-focusBorder/20 text-[10.5px] font-medium text-foreground cursor-pointer transition-colors"
                >
                  ✦ Black IDE Settings
                </button>
                <button
                  onClick={() => {
                    vscode.postMessage({ type: 'openEditorSettings' });
                    setShowSettingsDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-focusBorder/20 text-[10.5px] font-medium text-foreground cursor-pointer transition-colors"
                >
                  ⚙️ Editor Settings
                </button>
                <button
                  onClick={() => {
                    vscode.postMessage({ type: 'openExtensions' });
                    setShowSettingsDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-focusBorder/20 text-[10.5px] font-medium text-foreground cursor-pointer transition-colors"
                >
                  🧩 Extensions
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Views */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 min-h-0 bg-background overflow-x-hidden">
        <div className="flex flex-col gap-3 max-w-full overflow-x-hidden">
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`flex flex-col max-w-[95%] message-fade-in ${
                  msg.sender === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                }`}
              >
                {/* Text Bubble — no User/Assistant labels */}
                {(msg.sender === 'user' || msg.text || !isGenerating) && (
                  <div 
                    className={`rounded-lg p-2.5 border text-[11.5px] leading-relaxed break-words whitespace-pre-wrap max-w-full ${
                      msg.sender === 'user' 
                        ? 'bg-darkAccent border-border text-foreground rounded-tr-none shadow-sm' 
                        : 'bg-panel border-border text-foreground rounded-tl-none shadow-sm'
                    }`}
                  >
                    {msg.text ? (
                      renderMessageText(msg.text)
                    ) : (
                      <div className="flex items-center gap-1 py-0.5">
                        <div className="w-1 h-1 rounded-full bg-focusBorder animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-1 h-1 rounded-full bg-focusBorder animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-1 h-1 rounded-full bg-focusBorder animate-bounce" style={{ animationDelay: '300ms' }} />
                        <span className="ml-1 text-[9.5px] text-muted/60 italic font-medium">Agent is thinking...</span>
                      </div>
                    )}
                    {/* Attachment indicators */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5 pt-1.5 border-t border-border/30">
                        {msg.attachments.map((att, i) => (
                          <span key={i} className="text-[9px] bg-neonPurple/10 text-neonPurple px-1.5 py-0.5 rounded-full flex items-center gap-1">
                            {att.type === 'image' || att.type === 'screenshot' ? <ImageIcon /> : <AttachIcon />}
                            {att.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* Undo this message's file changes (MF-43) */}
                {msg.sender === 'user' && msg.taskId && (
                  <UndoMessageButton messageId={msg.taskId} state={agentState} post={vscode.postMessage} />
                )}
                {/* Inline Activity & Terminal Obsolescence Prevention */}
                {msg.sender === 'agent' && (
                  <div className="mt-1.5 w-full max-w-full">
                    <PipelineLogPanel state={getMessageAgentState(msg)} post={vscode.postMessage} />
                    <ActivityPanel state={getMessageAgentState(msg)} post={vscode.postMessage} />
                    <TerminalPanel state={getMessageAgentState(msg)} post={vscode.postMessage} />
                  </div>
                )}
              </div>
            ))}

            {/* Collapsible Reasoning Loading Area */}
            {isGenerating && settings.enableReasoningDisplay && (
              <div className="border border-border rounded-lg bg-panel/30 overflow-hidden max-w-[95%] mr-auto text-left shadow-sm message-fade-in">
                <div 
                  onClick={() => setIsReasoningExpanded(!isReasoningExpanded)}
                  className="flex items-center justify-between px-2.5 py-1.5 bg-panel border-b border-border/60 cursor-pointer select-none hover:bg-opacity-80 transition-colors"
                >
                  <div className="flex items-center gap-1.5 text-neonPurple font-semibold text-[10.5px]">
                    <div className="w-1.5 h-1.5 rounded-full bg-neonPurple animate-ping" />
                    <span>✦ Reasoning & Agent Execution</span>
                  </div>
                  <span className="text-[9px] text-muted uppercase">
                    {isReasoningExpanded ? 'Hide' : 'Show Details'}
                  </span>
                </div>

                {isReasoningExpanded && (
                  <div className="p-2.5 flex flex-col gap-2 max-w-full font-mono text-[10.5px] text-muted overflow-x-hidden">
                    {currentReasoningText ? (
                      <div className="whitespace-pre-wrap break-all leading-normal max-w-full text-foreground opacity-85">
                        {currentReasoningText}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 py-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '300ms' }} />
                        <span className="ml-1 text-[10px] text-muted italic">Consulting loop model...</span>
                      </div>
                    )}
                    {agentLogs.length > 0 && (
                      <div className="text-[9px] border-t border-border/40 pt-1.5 mt-1.5 flex flex-col gap-0.5 opacity-60">
                        <span className="font-semibold text-foreground uppercase tracking-wider text-[8px] mb-0.5">Execution Steps:</span>
                        {agentLogs.slice(-2).map((log, idx) => (
                          <div key={idx} className="truncate">❯ {log}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
      </div>

      {/* Input / Control Footer */}
      <div className="p-2 border-t border-border bg-background">

        {/* Live plan / TODO (Phase 3) */}
        {agentPlan.length > 0 && (
          <div className="mb-2 rounded-md border border-border bg-panel/40 p-2">
            <div className="text-[9px] uppercase tracking-wider text-muted/60 font-mono mb-1">Plan</div>
            <ul className="flex flex-col gap-0.5">
              {agentPlan.map((step, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[11px]">
                  <span>{step.status === 'done' ? '✅' : step.status === 'in_progress' ? '🔄' : '⬜'}</span>
                  <span className={step.status === 'done' ? 'line-through text-muted/60' : 'text-foreground'}>{step.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}


        {/* Plan Approval Card — Antigravity Pattern */}
        {agentState.phase === 'awaiting_approval' && agentState.pendingPlan && (
          <div className="mb-2 rounded-lg border-2 border-focusBorder/50 bg-panel/60 p-3 backdrop-blur shadow-md">
            <div className="text-[10px] uppercase tracking-wider text-focusBorder font-mono font-bold mb-2 flex items-center gap-1.5">
              📋 Implementation Plan Ready for Review
            </div>
            
            <details className="mb-2">
              <summary className="text-[11px] text-foreground cursor-pointer hover:text-focusBorder transition-colors font-medium">
                View Implementation Plan
              </summary>
              <pre className="mt-1 text-[10px] text-muted/80 bg-background/50 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono border border-border/30">
                {agentState.pendingPlan.planContent}
              </pre>
            </details>

            <details className="mb-3">
              <summary className="text-[11px] text-foreground cursor-pointer hover:text-focusBorder transition-colors font-medium">
                View Task List
              </summary>
              <pre className="mt-1 text-[10px] text-muted/80 bg-background/50 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono border border-border/30">
                {agentState.pendingPlan.taskContent}
              </pre>
            </details>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  vscode.postMessage({ type: 'approvePlan' });
                  dispatchAgent({ type: 'PlanApproved', ts: Date.now() });
                  setIsGenerating(true);
                }}
                className="flex-1 text-[11px] font-semibold py-1.5 px-3 rounded-md bg-green-600/80 hover:bg-green-600 text-white transition-colors cursor-pointer text-center"
              >
                ✅ Approve & Execute
              </button>
              <button
                onClick={() => {
                  vscode.postMessage({ type: 'rejectPlan' });
                  dispatchAgent({ type: 'PlanRejected', ts: Date.now() });
                }}
                className="flex-1 text-[11px] font-semibold py-1.5 px-3 rounded-md bg-red-600/30 hover:bg-red-600/50 text-red-400 border border-red-600/30 transition-colors cursor-pointer text-center"
              >
                ❌ Reject & Revise
              </button>
            </div>
          </div>
        )}

        {/* Artifact cards (Phase 3) */}
        {agentArtifacts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {agentArtifacts.map((a, i) => (
              <button
                key={i}
                onClick={() => vscode.postMessage({ type: 'openArtifact', value: a.path })}
                className="text-[10px] flex items-center gap-1 px-2 py-1 rounded-md border border-focusBorder/30 bg-focusBorder/10 text-focusBorder hover:bg-focusBorder/20 transition-colors cursor-pointer"
                title={a.path}
              >
                📄 {a.name} <span className="opacity-60">· {a.type}</span>
              </button>
            ))}
          </div>
        )}

        {/* Modified-files review: per-file Diff / Keep / Restore */}
        <ReviewPanel state={agentState} post={vscode.postMessage} />

        {/* Durable checkpoint timeline (MF-03): Restore All / per-file diff */}
        <CheckpointTimelinePanel state={agentState} post={vscode.postMessage} />

        {/* Parallel subagents status */}
        <ParallelSubagentsPanel state={agentState} post={vscode.postMessage} />

        {/* Mode selector (Phase 3 with Custom Modes MF-19) */}
        <div className="mb-1.5 flex items-center gap-1">
          <button
            onClick={() => !isGenerating && vscode.postMessage({ type: 'openModeSelector', value: agentMode })}
            disabled={isGenerating}
            className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors cursor-pointer capitalize flex flex-row items-center gap-1.5 ${
              isGenerating
                ? 'border-border text-muted opacity-50 cursor-default'
                : 'border-focusBorder bg-focusBorder/15 text-focusBorder hover:bg-focusBorder/25 font-semibold'
            }`}
            title="Click to change Agent Mode"
          >
            <span>{customModes.find(m => m.name.toLowerCase() === agentMode)?.name || agentMode}</span>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 5h8l-4 6-4-6z" />
            </svg>
          </button>
        </div>

        <div className={`relative flex flex-col border rounded-md transition-all duration-150 p-2 ${
          isGenerating
            ? 'border-border/40 bg-panel/30 opacity-75'
            : 'border-inputBorder bg-inputBg focus-within:border-focusBorder'
        }`}>
          
          {/* Token Usage Stats Bar — Feature 12 */}
          {tokenUsage && (
            <div className="flex items-center justify-between text-[9px] text-muted/50 border-b border-[rgba(255,255,255,0.04)] pb-1 mb-1.5 px-1 font-mono">
              <div className="flex items-center gap-1.5">
                <span>Total: <strong className="text-foreground">{tokenUsage.totalTokens}</strong></span>
                <span>•</span>
                <span>Last Turn: <strong className="text-foreground">{tokenUsage.turnTokens}</strong></span>
                <span>•</span>
                <span>Turns: <strong className="text-foreground">{tokenUsage.turns}</strong></span>
              </div>
              <div className="text-focusBorder font-semibold">
                Est. Cost: {tokenUsage.totalCost}
              </div>
            </div>
          )}

          {/* Loop Limit Warning Bar */}
          {loopLimitWarning && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-amber-500/20 bg-amber-500/[0.06] text-[9.5px] text-amber-400/80 mb-1.5 font-medium"
                 role="alert" aria-live="assertive">
              ⚠️ Agent is approaching the iteration limit ({loopLimitWarning.remaining} remaining of {loopLimitWarning.maxTurns}).
            </div>
          )}

          {/* Attached files preview */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5 px-1">
              {attachedFiles.map((file, i) => (
                <span key={i} className="text-[9px] bg-neonPurple/10 text-neonPurple px-1.5 py-0.5 rounded-md flex items-center gap-1 border border-neonPurple/20">
                  {file.type === 'image' || file.type === 'screenshot' ? <ImageIcon /> : <AttachIcon />}
                  {file.name}
                  <button onClick={() => removeAttachment(i)} className="hover:text-dangerRed transition-colors ml-0.5 cursor-pointer">×</button>
                </span>
              ))}
            </div>
          )}

          {/* Autocomplete dropdown menus */}
          {showSlashDropdown && (
            <div className="absolute left-3 bottom-[calc(100%+8px)] bg-panel border border-border rounded-md shadow-lg overflow-hidden min-w-[150px] z-50">
              {slashSuggestions.map((cmd, i) => (
                <div
                  key={cmd}
                  onClick={() => {
                    setInputText(cmd + ' ');
                    setShowSlashDropdown(false);
                  }}
                  className={`px-3 py-1.5 hover:bg-focusBorder/20 cursor-pointer text-[10.5px] ${
                    slashDropdownIndex === i ? 'bg-focusBorder/20 text-white font-semibold' : 'text-muted'
                  }`}
                >
                  {cmd}
                </div>
              ))}
            </div>
          )}

          {showContextDropdown && contextSuggestions.length > 0 && (
            <div className="absolute left-3 bottom-[calc(100%+8px)] bg-panel border border-border rounded-md shadow-lg overflow-hidden min-w-[200px] max-h-[150px] overflow-y-auto z-50">
              {contextSuggestions.map((file, i) => (
                <div
                  key={file}
                  onClick={() => {
                    const atIndex = inputText.lastIndexOf('@');
                    const newText = inputText.slice(0, atIndex) + `@${file} `;
                    setInputText(newText);
                    setShowContextDropdown(false);
                  }}
                  className={`px-3 py-1.5 hover:bg-focusBorder/20 cursor-pointer text-[10.5px] truncate ${
                    contextDropdownIndex === i ? 'bg-focusBorder/20 text-white font-semibold' : 'text-muted'
                  }`}
                >
                  @{file}
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
            placeholder={isGenerating ? "Agent is processing task..." : "Ask a question or request a task..."}
            rows={1}
            className="chat-textarea w-full bg-transparent text-foreground placeholder:text-muted/40 resize-none outline-none text-[11.5px] leading-normal max-h-[240px] py-0.5 disabled:cursor-not-allowed overflow-y-auto select-text selection:bg-focusBorder/20"
          />

          {/* Bottom Bar: Plus menu & model selector on left, Send/Cancel on right */}
          <div className="flex justify-between items-center mt-1.5">
            {/* Left: Plus button & Model Selector */}
            <div className="flex items-center gap-1.5">
              <div className="relative" ref={plusMenuRef}>
                <button
                  onClick={() => setShowPlusMenu(!showPlusMenu)}
                  disabled={isGenerating}
                  className={`p-1 rounded-md transition-colors flex items-center justify-center active:scale-98 ${
                    isGenerating 
                      ? 'opacity-30 cursor-not-allowed' 
                      : 'text-muted hover:text-foreground hover:bg-panel cursor-pointer'
                  }`}
                  title="Attach file, screenshot, or mention"
                >
                  <PlusIcon />
                </button>

                {/* Plus menu popup */}
                {showPlusMenu && (
                  <div className="plus-menu animate-slide-up rounded-md">
                    <div className="plus-menu-item" onClick={handleAttachFile}>
                      <AttachIcon />
                      <span>Attach File</span>
                    </div>
                    <div className="plus-menu-item" onClick={handleAttachScreenshot}>
                      <ImageIcon />
                      <span>Attach Screenshot</span>
                    </div>
                    <div className="border-t border-border/30 my-0.5" />
                    <div className="plus-menu-item" onClick={handleMention}>
                      <AtIcon />
                      <span>@ Mention</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Model Selector */}
              <div className="flex items-center" ref={modelDropdownRef}>
                <button
                  onClick={() => !isGenerating && setShowModelDropdown(!showModelDropdown)}
                  disabled={isGenerating}
                  className="flex items-center gap-1.5 hover:bg-panel rounded-md px-1.5 py-0.5 transition-colors cursor-pointer border-0 bg-transparent text-muted font-normal hover:text-foreground outline-none text-[10px] disabled:opacity-50 disabled:cursor-not-allowed max-w-[140px]"
                >
                  <span className={`w-1 h-1 rounded-full shrink-0 ${isGenerating ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`} />
                  <span className="truncate">
                    {modelsList.find(m => m.id === selectedModelId)?.name || 'No models'}
                  </span>
                  <svg className={`w-2 h-2 fill-current opacity-60 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} viewBox="0 0 24 24">
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>

                {showModelDropdown && (
                  <div className="absolute left-2 right-2 sm:left-2 sm:right-auto sm:w-[220px] bottom-[calc(100%+8px)] bg-panel border border-border rounded-md shadow-lg py-1 max-h-[260px] overflow-y-auto z-50 text-left animate-slide-up select-none">
                    {modelsList.length === 0 ? (
                      <div className="px-3 py-1.5 text-muted text-[10px]">No models configured</div>
                    ) : (
                      Object.entries(groupModels(modelsList.filter(m => m.enabled !== false))).map(([groupName, groupModels]) => {
                        if (groupModels.length === 0) return null;
                        return (
                          <div key={groupName} className="flex flex-col">
                            <span className="px-3 py-1.5 text-[9px] font-bold text-muted uppercase tracking-wider bg-background/25">
                              {groupName}
                            </span>
                            {groupModels.map(model => {
                              const isActive = model.id === selectedModelId;
                              return (
                                <button
                                  key={model.id}
                                  onClick={() => {
                                    setSelectedModelId(model.id);
                                    updateSetting('selectedModelId', model.id);
                                    setShowModelDropdown(false);
                                  }}
                                  className={`w-full text-left px-3 py-1.5 hover:bg-focusBorder/20 text-[10px] cursor-pointer transition-colors flex items-center justify-between gap-2 border-0 bg-transparent ${
                                    isActive ? 'text-foreground font-semibold bg-focusBorder/10' : 'text-muted hover:text-foreground'
                                  }`}
                                >
                                  <span className="truncate">{model.name}</span>
                                  {isActive && (
                                    <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2 shrink-0 text-focusBorder" viewBox="0 0 24 24">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: Send/Cancel button */}
            <div className="flex items-center">
              {isGenerating ? (
                <button
                  onClick={handleCancelTask}
                  className="w-6 h-6 rounded-md bg-dangerRed hover:bg-dangerRed/80 active:scale-98 text-white cursor-pointer flex items-center justify-center transition-colors"
                  title="Cancel Task"
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  onClick={handleSendMessage}
                  disabled={!inputText.trim()}
                  className={`w-6 h-6 rounded-md transition-colors flex items-center justify-center active:scale-98 ${
                    inputText.trim()
                      ? 'bg-buttonBg hover:bg-buttonHoverBg text-buttonFg cursor-pointer' 
                      : 'text-muted opacity-30 cursor-not-allowed'
                  }`}
                  title="Send Message"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
