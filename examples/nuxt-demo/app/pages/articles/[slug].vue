<script setup>
const route = useRoute();
const { data: article } = await useHybldData("article", { slug: route.params.slug });
useHead({
  title: `${article.value.title} | Nuxt Demo`,
  meta: [{ name: "description", content: article.value.excerpt.replace(/<[^>]*>/g, "").slice(0, 150) }],
});
</script>

<template>
  <div>
    <p><NuxtLink to="/">Nuxt Demo</NuxtLink></p>
    <article>
      <h1>{{ article.title }}</h1>
      <p>
        <small>{{ article.date.slice(0, 10) }} in <NuxtLink :to="`/category/${article.category}/`">{{ article.category }}</NuxtLink></small>
      </p>
      <div v-html="article.html" />
    </article>
  </div>
</template>
