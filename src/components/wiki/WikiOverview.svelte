<script lang="ts">
  import { GAME, SHIP } from '../../../shared/constants/gameplay';
  import { isShipKitId, listShipKits, SHIP_ABILITY } from '../../../shared/shipKits';
  import type { WikiArticle } from '../../wiki/article';
  import Table from '../ui/table/table.svelte';
  import TableBody from '../ui/table/table-body.svelte';
  import TableCaption from '../ui/table/table-caption.svelte';
  import TableCell from '../ui/table/table-cell.svelte';
  import TableHead from '../ui/table/table-head.svelte';
  import TableHeader from '../ui/table/table-header.svelte';
  import TableRow from '../ui/table/table-row.svelte';
  import ShipHull from './ShipHull.svelte';
  import TopicCard from './TopicCard.svelte';

  let { articles }: { articles: WikiArticle[] } = $props();
  const kits = listShipKits();
  const topics = $derived(articles.filter((article) => !isShipKitId(article.id)));
</script>

<section class="hero">
  <p class="eyebrow">THE PILOT'S REFERENCE</p>
  <h1>Know your ship.<br /><span>Read the arena.</span></h1>
  <p class="hero-copy">
    Scout and Hauler. A shared, unpredictable arena. Learn what everything does, see it in motion,
    then take it into flight.
  </p>
  <div class="hero-links">
    <a href="#controls" class="primary-link"
      >Start with the controls <span aria-hidden="true">→</span></a
    ><a href="#ships">Compare ships <span aria-hidden="true">↓</span></a>
  </div>
</section>
<section class="section-block" id="ships">
  <div class="section-heading">
    <div>
      <p class="eyebrow">01 / HANGAR</p>
      <h2>Choose your ship</h2>
    </div>
    <span>One ability. A different way to fly.</span>
  </div>
  <div class="ship-grid">
    {#each kits as kit, index (kit.id)}<a class="ship-card" href={`#${kit.id}`}
        ><span class="ship-number">0{index + 1}</span><ShipHull id={kit.id} size={82} />
        <h3>{kit.name}</h3>
        <p>{kit.abilityName}</p>
        <span class="ship-health">{kit.maxHealth} HULL <span aria-hidden="true">↗</span></span></a
      >{/each}
  </div>
  <details class="comparison">
    <summary>Compare hull, handling, and ability cooldowns</summary>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (This named scroll region needs keyboard focus to scroll the wide table on narrow screens.) -->
    <div class="table-scroll" role="region" aria-label="Ship comparison" tabindex="0">
      <Table class="caption-top">
        <TableCaption>Starting ship values, before growth or upgrades</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Ship</TableHead>
            <TableHead scope="col">Hull</TableHead>
            <TableHead scope="col">Thrust</TableHead>
            <TableHead scope="col">Speed cap</TableHead>
            <TableHead scope="col">Turn °/s</TableHead>
            <TableHead scope="col">Shot interval</TableHead>
            <TableHead scope="col">E cooldown</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each kits as kit (kit.id)}
            <TableRow>
              <TableHead scope="row"><a href={`#${kit.id}`}>{kit.name}</a></TableHead>
              <TableCell>{kit.maxHealth}</TableCell>
              <TableCell>{SHIP.THRUST}</TableCell>
              <TableCell>{SHIP.MAX_VELOCITY}</TableCell>
              <TableCell>{SHIP.TURN_SPEED}</TableCell>
              <TableCell>{kit.shotCooldown} ms</TableCell>
              <TableCell>{SHIP_ABILITY.COOLDOWN_FRAMES[kit.id] / GAME.FPS} s</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
    <p>
      Thrust and speed cap are game tuning values for comparison, not screen pixels per second.
      Boost, abilities, and terrain can alter movement.
    </p>
  </details>
</section>
<section class="section-block">
  <div class="section-heading">
    <div>
      <p class="eyebrow">02 / FIELD NOTES</p>
      <h2>Understand the arena</h2>
    </div>
    <span>Rules, controls, and interactions.</span>
  </div>
  <div class="topic-grid">
    {#each topics as article (article.id)}<TopicCard {article} headingLevel={3} />{/each}
  </div>
</section>

<style>
  .hero,
  .section-block {
    margin-bottom: 3rem;
  }
  .hero-links {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .ship-grid,
  .topic-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 1rem;
    margin: 1.5rem 0;
  }
  .ship-card {
    display: block;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--card);
  }
  /* The focusable, named .table-scroll region stays the only scroller around the table primitive. */
  .table-scroll {
    overflow: auto;
  }
  .table-scroll > :global([data-slot='table-container']) {
    overflow: visible;
  }
</style>
