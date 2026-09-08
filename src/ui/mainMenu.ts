import { setSound } from '../audio/Sound';
import { GameController } from '../core/gameController';
import { initTitleStarfield } from '../rendering/starfield';
import { getBuildInfoString } from '../utils/buildInfo';
import { applyLockedPaletteCss } from '../utils/colorUtils';
import { attachEventListener, getElementById } from '../utils/dom';
import { logger } from '../utils/Logger';
import { getSelectedShipKitId, mountShipKitSelect } from './shipKitSelect';
import { controlsHintFor } from './viewportChrome';

// UI element references
const soundCheckBox = getElementById<HTMLInputElement>('soundPref');
const startGameBtn = getElementById<HTMLButtonElement>('start-game');
const playerNameInput = getElementById<HTMLInputElement>('playerNameInput');

// Helper function to get game controller instance
function getGameController() {
  return GameController.getInstance();
}

// Generate fun, space-themed nicknames
function generateFunNickname(): string {
  const adjectives = [
    'Crimson',
    'Nebula',
    'Quantum',
    'Cosmic',
    'Lunar',
    'Solar',
    'Galactic',
    'Star',
    'Nova',
    'Meteor',
    'Stellar',
    'Astral',
    'Celestial',
    'Orbital',
    'Interstellar',
    'Void',
    'Ethereal',
    'Mystic',
    'Shadow',
    'Phantom',
    'Blazing',
    'Frozen',
    'Thunder',
    'Lightning',
    'Storm',
    'Titan',
    'Dragon',
    'Phoenix',
    'Wolf',
    'Eagle',
    'Cyber',
    'Neon',
    'Digital',
    'Pixel',
    'Retro',
    'Future',
    'Time',
    'Space',
    'Dimension',
    'Reality',
  ];

  const nouns = [
    'Falcon',
    'Viper',
    'Ranger',
    'Specter',
    'Comet',
    'Warden',
    'Drifter',
    'Marauder',
    'Pioneer',
    'Corsair',
    'Guardian',
    'Sentinel',
    'Hunter',
    'Warrior',
    'Knight',
    'Mage',
    'Archer',
    'Assassin',
    'Paladin',
    'Rogue',
    'Blade',
    'Sword',
    'Shield',
    'Armor',
    'Helmet',
    'Crown',
    'Throne',
    'Tower',
    'Castle',
    'Fortress',
    'Storm',
    'Thunder',
    'Lightning',
    'Fire',
    'Ice',
    'Wind',
    'Earth',
    'Water',
    'Light',
    'Dark',
  ];

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective} ${noun}`;
}

// Set up game button - directly start game with nickname input
attachEventListener(startGameBtn, 'click', () => {
  void startGameWithName();
});

// Function to start game with the entered name
let startingGame = false;
async function startGameWithName(): Promise<void> {
  if (startingGame) {
    return;
  }
  let playerName = '';

  logger.debug('UI', 'startGameWithName called');

  if (playerNameInput?.value.trim()) {
    const playerNameRaw = playerNameInput.value.trim();

    // Apply name validation
    const MAX_LEN = 20;
    const validatedName = playerNameRaw.slice(0, MAX_LEN);

    // Validate player name (alphanumeric only)
    playerName = validatedName.replace(/[^A-Za-z0-9]/g, '');

    logger.debug('UI', 'Using validated player name', { source: 'user' });
  }

  // If no valid name entered, use the pre-generated nickname
  if (!playerName) {
    playerName = generatedNickname;
    logger.debug('UI', 'Using generated player name', { source: 'generated' });

    // Update the input field to show the nickname
    if (playerNameInput) {
      playerNameInput.value = playerName;
      playerNameInput.classList.add('default-nickname');
    }
  } else {
    // Remove default nickname styling if user entered a custom name
    if (playerNameInput) {
      playerNameInput.classList.remove('default-nickname');
    }
  }

  logger.debug('UI', 'Starting game with selected identity', { nameLength: playerName.length });

  // Update button state
  startGameBtn?.classList.add('active-mode');

  startingGame = true;
  if (startGameBtn) {
    startGameBtn.disabled = true;
  }
  try {
    await getGameController().startGame(playerName, getSelectedShipKitId());
  } catch {
    // GameController restores the menu, logs the cause and displays the retry banner.
    startGameBtn?.classList.remove('active-mode');
  } finally {
    startingGame = false;
    if (startGameBtn) {
      startGameBtn.disabled = false;
    }
  }
}

// Set up player name input to allow Enter key to start game
if (playerNameInput) {
  attachEventListener(playerNameInput, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      void startGameWithName();
    }
  });

  // Clear default nickname styling when user starts typing
  attachEventListener(playerNameInput, 'input', () => {
    playerNameInput.classList.remove('default-nickname');
  });
}

attachEventListener(soundCheckBox, 'change', (ev) => {
  const target = ev.target as HTMLInputElement;
  setSound(target.checked);
});

// Display build info
function displayBuildInfo(): void {
  const buildInfoElement = getElementById<HTMLElement>('buildInfo');
  if (buildInfoElement) {
    buildInfoElement.textContent = getBuildInfoString();
  }
}

// Initialize build info display
displayBuildInfo();
applyLockedPaletteCss();
initTitleStarfield();
mountShipKitSelect();

function syncControlsHint(): void {
  const hint = getElementById<HTMLElement>('controls-hint');
  if (hint) {
    hint.textContent = controlsHintFor();
  }
}

syncControlsHint();
window.addEventListener('resize', syncControlsHint);
window.visualViewport?.addEventListener('resize', syncControlsHint);

// Generate a nickname once and use it consistently
const generatedNickname = generateFunNickname();

// Set the generated nickname as placeholder
if (playerNameInput) {
  playerNameInput.placeholder = generatedNickname;
  logger.debug('UI', 'Set generated name placeholder');
}
