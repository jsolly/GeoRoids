import { RadarChart } from 'echarts/charts';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { GAME } from '../constants';
import { getShipKit, listShipKits, SHIP_ABILITY, type ShipKitId } from '../entities/ship/shipKits';

use([RadarChart, SVGRenderer]);

type Kit = ReturnType<typeof getShipKit>;
const stats = [
  { label: 'Hull', axis: 'Hull', value: (kit: Kit) => kit.maxHealth, unit: '', lower: false },
  { label: 'Size', axis: 'Compact', value: (kit: Kit) => kit.size, unit: '', lower: true },
  { label: 'Thrust', axis: 'Thrust', value: (kit: Kit) => kit.thrust, unit: '', lower: false },
  {
    label: 'Speed cap',
    axis: 'Speed',
    value: (kit: Kit) => kit.maxVelocity,
    unit: '',
    lower: false,
  },
  {
    label: 'Turn rate',
    axis: 'Turning',
    value: (kit: Kit) => kit.turnSpeed,
    unit: '°/s',
    lower: false,
  },
  {
    label: 'Shot interval',
    axis: 'Fire rate',
    value: (kit: Kit) => kit.shotCooldown,
    unit: ' ms',
    lower: true,
  },
  {
    label: 'E cooldown',
    axis: 'Recharge',
    value: (kit: Kit) => SHIP_ABILITY.COOLDOWN_FRAMES[kit.id] / GAME.FPS,
    unit: 's',
    lower: true,
  },
];

/** Same 1–5 scale for radar and bubbles; tied base values always receive equal ratings. */
export function shipRatings(id: ShipKitId) {
  const kit = getShipKit(id);
  return stats.map((stat) => {
    const values = listShipKits().map(stat.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const value = stat.value(kit);
    const fraction = max === min ? 0.5 : (value - min) / (max - min);
    const rating = Math.round(1 + 4 * (stat.lower ? 1 - fraction : fraction));
    return { label: stat.label, axis: stat.axis, display: `${value}${stat.unit}`, rating };
  });
}

export function shipScorecard(id: ShipKitId): string {
  const kit = getShipKit(id);
  const rows = shipRatings(id)
    .map(
      (stat) =>
        `<div class="ship-stat"><dt>${stat.label}</dt><dd><span class="ship-stat-value">${stat.display}</span><span class="stat-bubbles" role="img" aria-label="${stat.rating} out of 5" title="${stat.rating} out of 5">${[1, 2, 3, 4, 5].map((level) => `<span class="stat-bubble${level <= stat.rating ? ' filled' : ''}" aria-hidden="true"></span>`).join('')}</span></dd></div>`
    )
    .join('');
  return `<section class="ship-scorecard" aria-labelledby="${id}-scorecard-title"><div class="ship-scorecard-heading"><div><p class="eyebrow">SHIP PROFILE</p><h2 class="ship-scorecard-title" id="${id}-scorecard-title">At a glance</h2></div><p class="ship-ability-name"><span class="ship-ability-label">E ABILITY</span>${kit.abilityName}</p></div><div class="ship-profile-layout"><div class="ship-radar" role="img" aria-label="${kit.name} base stat profile, rated from 1 to 5. Exact values and ratings follow."></div><dl class="ship-stat-grid">${rows}</dl></div><details class="ship-rating-guide"><summary>How to read the ratings</summary><p>More filled bubbles means a stronger base stat compared with the other ships. Each stat runs from 1 for the fleet’s lowest value to 5 for its highest, rounded to a whole bubble. Smaller size and shorter shot intervals and cooldowns score higher. Special abilities, growth, and upgrades aren’t ranked.</p></details></section>`;
}

/** A single SVG chart per article, with explicit cleanup when navigation replaces the card. */
export function mountShipRadar(element: HTMLElement, id: ShipKitId): () => void {
  const ratings = shipRatings(id);
  const chart = init(element, undefined, { renderer: 'svg' });
  chart.setOption({
    animation: false,
    radar: {
      center: ['50%', '51%'],
      radius: '62%',
      splitNumber: 5,
      indicator: ratings.map((stat) => ({ name: stat.axis, min: 0, max: 5 })),
      axisName: { color: '#aebfd0', fontSize: 11, fontFamily: 'sans-serif' },
      axisNameGap: 10,
      axisLine: { lineStyle: { color: '#2d4151' } },
      splitLine: { lineStyle: { color: '#2d4151' } },
      splitArea: { areaStyle: { color: ['#0c1722', '#10212b'] } },
    },
    series: [
      {
        type: 'radar',
        silent: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: '#5eead4', width: 2 },
        itemStyle: { color: '#5eead4' },
        areaStyle: { color: '#5eead4', opacity: 0.22 },
        data: [{ value: ratings.map((stat) => stat.rating), name: getShipKit(id).name }],
      },
    ],
  });
  const observer = new ResizeObserver(() => chart.resize());
  observer.observe(element);
  return () => {
    observer.disconnect();
    chart.dispose();
  };
}
