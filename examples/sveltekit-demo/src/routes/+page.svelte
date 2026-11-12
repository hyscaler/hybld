<script>
  let { data } = $props();
</script>

<svelte:head>
  <title>SvelteKit Demo (hybld)</title>
  <meta name="description" content="hybld incremental builds on SvelteKit" />
</svelte:head>

<h1>Latest articles (SvelteKit)</h1>
<ul>
  {#each data.latest as a}
    <li>
      <a href={`/articles/${a.slug}/`}>{a.title}</a>
      <small> ({a.date.slice(0, 10)}, <a href={`/category/${a.category}/`}>{a.category}</a>)</small>
    </li>
  {/each}
</ul>
