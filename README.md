# Auto Poly Bet Bot

An automated betting bot for Polymarket built with Next.js, TypeScript, Tailwind CSS, and HeroUI components.

## Features

- ✅ **Next.js 15** with App Router
- ✅ **TypeScript** for type safety
- ✅ **Tailwind CSS** for styling
- ✅ **HeroUI Components** for modern UI elements
- ✅ **Zustand** for state management
- ✅ **Light/Dark Theme** with system preference detection and localStorage persistence
- ✅ **Responsive Design** with collapsible sidebar
- ✅ **Header & Sidebar Navigation**
- ✅ **Security Hardened** - All known vulnerabilities patched

## Tech Stack

- **Framework**: Next.js 15.5.12
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Library**: HeroUI (@heroui/react)
- **State Management**: Zustand
- **Animations**: Framer Motion

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone https://github.com/jojokimys/auto-poly-bet-bot.git
cd auto-poly-bet-bot
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm start
```

## Project Structure

```
auto-poly-bet-bot/
├── app/                    # Next.js App Router pages
│   ├── bets/              # Bets page
│   ├── settings/          # Settings page
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Dashboard page
│   └── globals.css        # Global styles
├── components/            # React components
│   ├── Header.tsx         # Header with theme toggle
│   ├── Sidebar.tsx        # Navigation sidebar
│   └── ThemeProvider.tsx  # Theme management
├── store/                 # Zustand stores
│   └── useAppStore.ts     # App state management
├── tailwind.config.ts     # Tailwind configuration
├── tsconfig.json          # TypeScript configuration
└── package.json           # Dependencies
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Theme Support

The application supports both light and dark themes:
- Toggle theme using the button in the header
- Theme preference is saved to localStorage
- Automatically detects system preference on first visit
- Graceful fallback when localStorage is unavailable

## State Management

Zustand is used for managing:
- Theme state (light/dark)
- Sidebar visibility
- Other application state

## Screenshots

### Light Mode
![Light Mode Dashboard](https://github.com/user-attachments/assets/9b0c200b-3450-4a2a-aa32-7b0e01d488c1)

### Dark Mode
![Dark Mode Dashboard](https://github.com/user-attachments/assets/ed014a14-ee57-403d-ac81-e0acf9c290b9)

## License

MIT
auto-poly-bet-bot
