# CT-ContextUsageIndicator

A SillyTavern/CozyTavern extension that displays real-time token usage with a circular progress ring and detailed breakdown popover. Monitor your context window usage at a glance with an elegant, unobtrusive interface.

## Features

- **Visual Progress Ring**: Circular indicator showing context usage percentage at a glance
- **Detailed Breakdown**: Click to view comprehensive token usage statistics including:
  - Chat History tokens
  - World Info tokens
  - Character Description tokens
  - Persona Description tokens
  - Total tokens vs. Max Context budget
- **Real-time Updates**: Automatically refreshes when prompts are generated or settings change
- **Theme Support**: Adapts to both light and dark themes
- **OpenAI Integration**: Leverages SillyTavern's prompt manager for accurate token counting
- **Responsive Design**: Works seamlessly on desktop and mobile devices

## Installation and Usage

### Installation

1. Open SillyTavern
2. Navigate to **Extensions** > **Install Extension**
3. Enter the repository URL: `https://github.com/leyam3k/CT-ContextUsageIndicator`
4. Click **Install**

Alternatively, manually clone this repository into your SillyTavern extensions directory:
```bash
cd [SillyTavern]/public/scripts/extensions/third-party/
git clone https://github.com/leyam3k/CT-ContextUsageIndicator
```

### Usage

Once installed, the extension automatically adds a circular progress indicator to the left side of the send form (next to the extensions menu button).

- **View Usage**: The ring fills based on your current context usage percentage
- **Detailed Stats**: Click the ring to open a popover with detailed token breakdowns
- **Close Popover**: Click outside the popover or click the ring again to close

The indicator updates automatically when:
- A new prompt is generated
- Settings are changed
- The API is switched
- The chat is changed

## Prerequisites

- **SillyTavern**: Version 1.12.0 or higher recommended

## How It Works

The extension integrates with SillyTavern's internal prompt manager and tokenizer to provide accurate token counts. It monitors various events (prompt generation, settings updates, chat changes) and recalculates usage in real-time.

For OpenAI APIs, it extracts token counts from the itemized prompt system to match the "Copy Prompt" token count as closely as possible.

## License

MIT
