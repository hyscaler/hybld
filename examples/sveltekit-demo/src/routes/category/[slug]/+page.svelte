<script>
  let { data } = $props();
  const category = $derived(data.category);
</script>

<svelte:head>
  <title>{category.name} | SvelteKit Demo</title>
</svelte:head>

<p><a href="/">SvelteKit Demo</a></p>
<h1>{category.name}</h1>
<ul>
  {#each category.items as a}
    <li><a href={`/articles/${a.slug}/`}>{a.title}</a></li>
  {/each}
</ul>
