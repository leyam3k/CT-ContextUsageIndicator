/**
 * CT-ContextUsageIndicator Extension
 * Displays token usage with a circular progress ring and detailed breakdown
 */

import { eventSource, event_types, getMaxContextSize, max_context, amount_gen, main_api, chat } from '../../../../script.js';
import { promptManager } from '../../../openai.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { itemizedPrompts } from '../../../itemized-prompts.js';

const MODULE_NAME = 'CT-ContextUsageIndicator';
const CONTEXT_USAGE_UPDATED_EVENT = 'contextUsageUpdated';
const PROMPT_MANAGER_WAIT_TIMEOUT = 5000;
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// State
let latestSnapshot = null;
let promptManagerReadyPromise = null;
let updateInProgress = false;
let hostElement = null;
let popoverElement = null;
let isPopoverVisible = false;

// Formatters
const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percentageFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
});

/**
 * Utility: Clamp percentage between 0-100
 */
function clampPercent(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

/**
 * Utility: Format number with fallback
 */
function formatNumber(value) {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return '—';
    return numberFormatter.format(Math.max(0, Math.floor(value)));
}

/**
 * Utility: Format percentage
 */
function formatPercentage(value) {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return '0.0%';
    return `${percentageFormatter.format(Math.max(0, value))}%`;
}

/**
 * Wait for a condition with timeout
 */
function waitUntilCondition(condition, timeout = 5000, interval = 150) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
            if (condition()) {
                resolve(true);
            } else if (Date.now() - startTime >= timeout) {
                resolve(false);
            } else {
                setTimeout(check, interval);
            }
        };
        check();
    });
}

/**
 * Get context details from SillyTavern
 */
function getContextDetails() {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    const mainApi = ctx?.mainApi;

    const budget = Number(getMaxContextSize()) || 0;

    let contextSize = 0;
    if (mainApi === 'openai') {
        contextSize = Number(ctx?.chatCompletionSettings?.openai_max_context) || 0;
    }
    if (!contextSize) {
        contextSize = Number(ctx?.maxContext) || Number(max_context) || 0;
    }

    let responseLength = contextSize > 0 ? Math.max(0, contextSize - budget) : 0;
    if (!responseLength) {
        if (mainApi === 'openai') {
            responseLength = Number(ctx?.chatCompletionSettings?.openai_max_tokens) || 0;
        }
        if (!responseLength) {
            responseLength = Number(amount_gen) || 0;
        }
        if (!contextSize && (budget || responseLength)) {
            contextSize = Math.max(0, budget) + Math.max(0, responseLength);
        }
    }

    return {
        mainApi,
        contextSize,
        responseLength,
        budget: budget > 0 ? budget : Math.max(0, contextSize - responseLength),
    };
}

/**
 * Ensure prompt manager is ready
 */
async function ensurePromptManagerReady() {
    if (promptManager?.tokenHandler) return true;
    if (!promptManagerReadyPromise) {
        promptManagerReadyPromise = waitUntilCondition(
            () => Boolean(promptManager?.tokenHandler),
            PROMPT_MANAGER_WAIT_TIMEOUT,
            150
        ).finally(() => {
            promptManagerReadyPromise = null;
        });
    }
    await promptManagerReadyPromise;
    return Boolean(promptManager?.tokenHandler);
}

/**
 * Build context usage snapshot
 */
async function buildContextUsageSnapshot() {
    const { budget, contextSize, responseLength, mainApi } = getContextDetails();

    let totalTokens = null;
    const showPromptSection = mainApi === 'openai';
    let tokensReady = false;
    let chatHistoryTokens = null;
    let characterTokens = null;
    let personaTokens = null;
    let worldInfoTokens = null;

    if (showPromptSection && (await ensurePromptManagerReady())) {
        const handler = promptManager?.tokenHandler;
        tokensReady = Boolean(handler);

        if (tokensReady) {
            const counts = typeof handler?.getCounts === 'function' ? handler.getCounts() : null;
            const readCount = (key) => {
                if (!counts || typeof counts !== 'object') return 0;
                const value = counts[key];
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                return 0;
            };
            const sumCounts = (keys) => keys.reduce((sum, key) => sum + readCount(key), 0);

            // Get individual component breakdowns
            chatHistoryTokens = readCount('chatHistory');
            characterTokens = sumCounts(['charDescription', 'charPersonality', 'scenario']);
            personaTokens = readCount('personaDescription');
            worldInfoTokens = sumCounts(['worldInfoBefore', 'worldInfoAfter']);

            // Try to get the token count from the latest itemized prompt (what the native itemization uses)
            // This should match the "Copy Prompt" token count more closely
            try {
                if (Array.isArray(itemizedPrompts) && itemizedPrompts.length > 0) {
                    // Get the most recent itemized prompt
                    const latestPrompt = itemizedPrompts[itemizedPrompts.length - 1];
                    
                    if (latestPrompt && latestPrompt.rawPrompt) {
                        // Extract text from the raw prompt
                        let promptText = '';
                        if (Array.isArray(latestPrompt.rawPrompt)) {
                            // Chat completion format - extract content from all messages
                            promptText = latestPrompt.rawPrompt
                                .map(msg => msg.content || '')
                                .filter(content => content)
                                .join('\n');
                        } else if (typeof latestPrompt.rawPrompt === 'string') {
                            promptText = latestPrompt.rawPrompt;
                        }
                        
                        if (promptText) {
                            totalTokens = await getTokenCountAsync(promptText);
                        }
                    }
                }
            } catch (error) {
                console.warn('[ContextUsageIndicator] Error getting tokens from itemized prompt:', error);
            }

            // Fallback to handler.getTotal() if itemized prompt method didn't work
            if (!totalTokens || !Number.isFinite(totalTokens)) {
                totalTokens = typeof handler?.getTotal === 'function' ? handler.getTotal() : null;
            }

            // Validate total
            if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) {
                totalTokens = null;
                tokensReady = false;
            }
        }
    }

    const percent = tokensReady && budget > 0
        ? (totalTokens / budget) * 100
        : 0;

    return {
        percent,
        budget,
        contextSize,
        responseLength,
        totalTokens,
        showPromptSection,
        tokensReady,
        chatHistoryTokens,
        characterTokens,
        personaTokens,
        worldInfoTokens,
    };
}

/**
 * Update context usage and dispatch event
 */
async function updateContextUsage() {
    if (updateInProgress) return;
    updateInProgress = true;

    try {
        const snapshot = await buildContextUsageSnapshot();
        latestSnapshot = snapshot;

        document.dispatchEvent(
            new CustomEvent(CONTEXT_USAGE_UPDATED_EVENT, { detail: snapshot })
        );

        updateUI(snapshot);
    } finally {
        updateInProgress = false;
    }
}

/**
 * Create SVG ring element
 */
function createRingSVG(percent, disabled) {
    const safePercent = clampPercent(percent);
    const strokeDashoffset = RING_CIRCUMFERENCE - (safePercent / 100) * RING_CIRCUMFERENCE;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cui-ring');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('role', 'presentation');
    svg.setAttribute('aria-hidden', 'true');

    const trackCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    trackCircle.setAttribute('cx', '10');
    trackCircle.setAttribute('cy', '10');
    trackCircle.setAttribute('r', RING_RADIUS);
    trackCircle.setAttribute('class', 'cui-ring__track');

    // Add percentage marker lines at 25%, 50%, 75%, 100%
    const markers = [25, 50, 75, 100];
    markers.forEach(percentage => {
        const angle = (percentage / 100) * 360 - 90; // -90 to start from top
        const radians = (angle * Math.PI) / 180;
        // Start from the outer edge of the circle
        const x1 = 10 + (RING_RADIUS + 1) * Math.cos(radians);
        const y1 = 10 + (RING_RADIUS + 1) * Math.sin(radians);
        // Extend inward toward the center
        const x2 = 10 + (RING_RADIUS - 2) * Math.cos(radians);
        const y2 = 10 + (RING_RADIUS - 2) * Math.sin(radians);

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        line.setAttribute('class', 'cui-ring__marker');
        svg.appendChild(line);
    });

    const valueCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    valueCircle.setAttribute('cx', '10');
    valueCircle.setAttribute('cy', '10');
    valueCircle.setAttribute('r', RING_RADIUS);
    valueCircle.setAttribute('class', `cui-ring__value${disabled ? ' is-disabled' : ''}`);
    valueCircle.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`);
    valueCircle.setAttribute('stroke-dashoffset', strokeDashoffset);

    svg.appendChild(trackCircle);
    svg.appendChild(valueCircle);

    return svg;
}

/**
 * Create database icon SVG
 */
function createDatabaseIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.25');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    // Database-zap icon paths
    const paths = [
        'M 12 5 a 9 3 0 1 0 0 0.01',
        'M 3 5 V 19 A 9 3 0 0 0 15 21.84',
        'M 21 5 V 8',
        'M 21 12 L 18 17 H 22 L 19 22',
        'M 3 12 A 9 3 0 0 0 14.59 14.87'
    ];

    paths.forEach(d => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    });

    return svg;
}

/**
 * Create popover content
 */
function createPopoverContent(usage) {
    const hasUsage = Boolean(usage?.tokensReady) && Boolean(usage?.showPromptSection);
    const percent = hasUsage ? clampPercent(usage?.percent ?? 0) : 0;
    const usageDisplay = hasUsage ? formatPercentage(percent) : '—';
    const budgetDisplay = formatNumber(usage?.budget);
    const totalTokensDisplay = hasUsage ? formatNumber(usage?.totalTokens) : '—';

    const chatHistoryDisplay = hasUsage ? formatNumber(usage?.chatHistoryTokens) : '—';
    const worldInfoDisplay = hasUsage ? formatNumber(usage?.worldInfoTokens) : '—';
    const characterDisplay = hasUsage ? formatNumber(usage?.characterTokens) : '—';
    const personaDisplay = hasUsage ? formatNumber(usage?.personaTokens) : '—';

    const container = document.createElement('div');
    container.className = 'cui-popover__body';

    // Secondary stats
    const secondaryGrid = document.createElement('div');
    secondaryGrid.className = 'cui-text-grid';
    [
        { label: 'Chat History', value: chatHistoryDisplay },
        { label: 'World Info', value: worldInfoDisplay },
        { label: 'Character Description', value: characterDisplay },
        { label: 'Persona Description', value: personaDisplay },
    ].forEach(stat => {
        const row = document.createElement('div');
        row.className = 'cui-text-row';
        row.innerHTML = `
            <span class="cui-text-row__label">${stat.label}</span>
            <span class="cui-text-row__value">${stat.value}</span>
        `;
        secondaryGrid.appendChild(row);
    });

    // Divider
    const divider = document.createElement('div');
    divider.className = 'cui-divider';
    divider.setAttribute('aria-hidden', 'true');

    // Data pill
    const dataPill = document.createElement('div');
    dataPill.className = 'cui-data-pill';
    dataPill.setAttribute('aria-live', 'polite');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'cui-data-pill__icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.appendChild(createDatabaseIcon());

    const tokensSpan = document.createElement('span');
    tokensSpan.className = 'cui-data-pill__tokens';
    tokensSpan.textContent = totalTokensDisplay;

    const maxSpan = document.createElement('span');
    maxSpan.className = 'cui-data-pill__max';
    maxSpan.innerHTML = `
        <span class="cui-data-pill__separator">/</span>
        <span class="cui-data-pill__max-value">${budgetDisplay}</span>
    `;

    dataPill.appendChild(iconSpan);
    dataPill.appendChild(tokensSpan);
    dataPill.appendChild(maxSpan);

    // Primary stats
    const primaryGrid = document.createElement('div');
    primaryGrid.className = 'cui-text-grid--primary';
    [
        { label: 'Usage', value: usageDisplay },
        { label: 'Total Tokens', value: totalTokensDisplay },
        { label: 'Max Context', value: budgetDisplay },
    ].forEach(stat => {
        const row = document.createElement('div');
        row.className = 'cui-text-row';
        row.innerHTML = `
            <span class="cui-text-row__label">${stat.label}</span>
            <span class="cui-text-row__value">${stat.value}</span>
        `;
        primaryGrid.appendChild(row);
    });

    container.appendChild(secondaryGrid);
    container.appendChild(divider);
    container.appendChild(dataPill);
    container.appendChild(primaryGrid);

    if (!hasUsage) {
        const emptyMessage = document.createElement('p');
        emptyMessage.className = 'cui-popover__empty';
        emptyMessage.textContent = 'Context usage data becomes available after OpenAI prompt tokens are calculated.';
        container.appendChild(emptyMessage);
    }

    return container;
}

/**
 * Update UI with new snapshot
 */
function updateUI(snapshot) {
    if (!hostElement) return;

    const hasUsage = Boolean(snapshot?.tokensReady) && Boolean(snapshot?.showPromptSection);
    const percent = hasUsage ? clampPercent(snapshot?.percent ?? 0) : 0;
    const percentDisplay = hasUsage ? formatPercentage(percent) : '—';

    // Update tooltip
    hostElement.title = `Context Usage: ${percentDisplay}`;

    // Update ring
    const ring = hostElement.querySelector('.cui-ring');
    if (ring) {
        const newRing = createRingSVG(percent, !hasUsage);
        ring.replaceWith(newRing);
    }

    // Update popover content if visible
    if (isPopoverVisible && popoverElement) {
        const body = popoverElement.querySelector('.cui-popover__body');
        if (body) {
            const newContent = createPopoverContent(snapshot);
            body.replaceWith(newContent);
        }
    }
}

/**
 * Toggle popover visibility
 */
function togglePopover() {
    if (!popoverElement) return;

    isPopoverVisible = !isPopoverVisible;

    if (isPopoverVisible) {
        // Update content before showing
        const body = popoverElement.querySelector('.cui-popover__body');
        if (body && latestSnapshot) {
            const newContent = createPopoverContent(latestSnapshot);
            body.replaceWith(newContent);
        }

        popoverElement.style.display = 'block';
        // Position popover
        positionPopover();
    } else {
        popoverElement.style.display = 'none';
    }
}

/**
 * Position popover relative to trigger
 */
function positionPopover() {
    if (!hostElement || !popoverElement) return;

    const triggerRect = hostElement.getBoundingClientRect();
    const popoverRect = popoverElement.getBoundingClientRect();

    // Position above and slightly to the right of trigger
    const top = triggerRect.top - popoverRect.height - 8;
    const left = triggerRect.left + 8;

    popoverElement.style.top = `${top}px`;
    popoverElement.style.left = `${left}px`;
}

/**
 * Create and mount the UI
 */
function createUI() {
    const leftSendForm = document.getElementById('leftSendForm');
    const extensionsMenuButton = document.getElementById('extensionsMenuButton');
    
    if (!leftSendForm) {
        console.warn(`[${MODULE_NAME}] #leftSendForm not found`);
        return;
    }

    // Create host container
    if (!hostElement) {
        hostElement = document.createElement('div');
        hostElement.id = 'cui_button';
        hostElement.className = 'fa-solid interactable cui-trigger';
        hostElement.tabIndex = 0;

        const hasUsage = Boolean(latestSnapshot?.tokensReady) && Boolean(latestSnapshot?.showPromptSection);
        const percent = hasUsage ? clampPercent(latestSnapshot?.percent ?? 0) : 0;
        const percentDisplay = hasUsage ? formatPercentage(percent) : '—';
        hostElement.title = `Context Usage: ${percentDisplay}`;

        // Add ring only (no text)
        hostElement.appendChild(createRingSVG(percent, !hasUsage));

        // Add click handler
        hostElement.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePopover();
        });

        // Insert after extensionsMenuButton if it exists, otherwise append
        if (extensionsMenuButton && extensionsMenuButton.parentElement === leftSendForm) {
            extensionsMenuButton.insertAdjacentElement('afterend', hostElement);
        } else {
            leftSendForm.appendChild(hostElement);
        }
    }

    // Create popover
    if (!popoverElement) {
        popoverElement = document.createElement('div');
        popoverElement.className = 'cui-popover';
        popoverElement.style.display = 'none';

        const content = createPopoverContent(latestSnapshot || {});
        popoverElement.appendChild(content);

        document.body.appendChild(popoverElement);

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (isPopoverVisible && !popoverElement.contains(e.target) && e.target !== hostElement) {
                togglePopover();
            }
        });

        // Reposition on scroll/resize
        window.addEventListener('scroll', () => {
            if (isPopoverVisible) positionPopover();
        }, true);
        window.addEventListener('resize', () => {
            if (isPopoverVisible) positionPopover();
        });
    }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    const eventsToListen = [
        event_types.CHAT_COMPLETION_PROMPT_READY,
        event_types.SETTINGS_UPDATED,
        event_types.MAIN_API_CHANGED,
        event_types.CHAT_CHANGED,
    ].filter(Boolean);

    eventsToListen.forEach(eventName => {
        eventSource.on(eventName, () => {
            updateContextUsage();
        });
    });
}

/**
 * Ensure button exists in DOM
 */
function ensureButtonExists() {
    const leftSendForm = document.getElementById('leftSendForm');
    const existingButton = document.getElementById('cui_button');
    
    if (!existingButton && leftSendForm) {
        createUI();
    }
}

/**
 * Initialize extension
 */
async function initialize() {
    console.log(`[${MODULE_NAME}] Initializing...`);

    // Initial update
    await updateContextUsage();

    // Create UI
    createUI();

    // Setup event listeners
    setupEventListeners();

    // Watch for DOM changes (in case leftSendForm is recreated)
    const observer = new MutationObserver(() => {
        ensureButtonExists();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    console.log(`[${MODULE_NAME}] Initialized successfully`);
}

// Wait for APP_READY event
eventSource.on(event_types.APP_READY, initialize);

// Also run on CHAT_CHANGED as the UI might redraw
eventSource.on(event_types.CHAT_CHANGED, () => {
    ensureButtonExists();
});
