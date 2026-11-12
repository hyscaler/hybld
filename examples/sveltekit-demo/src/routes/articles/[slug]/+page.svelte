<script>
  let { data } = $props();
  const article = $derived(data.article);
</script>

<svelte:head>
  <title>{article.title} | SvelteKit Demo</title>
  <meta name="description" content={article.excerpt.replace(/<[^>]*>/g, "").slice(0, 150)} />
</svelte:head>

<p><a href="/">SvelteKit Demo</a></p>
<article>
  <h1>{article.title}</h1>
  <p>
    <small>{article.date.slice(0, 10)} in <a href={`/category/${article.category}/`}>{article.category}</a></small>
  </p>
  <div>{@html article.html}</div>
</article>
