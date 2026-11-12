<script setup>
const { data } = await useHybldData("home");
useHead({ title: "Nuxt Demo (hybld)", meta: [{ name: "description", content: "hybld incremental builds on Nuxt" }] });
</script>

<template>
  <div>
    <h1>Latest articles (Nuxt)</h1>
    <ul>
      <li v-for="a in data.latest" :key="a.slug">
        <NuxtLink :to="`/articles/${a.slug}/`">{{ a.title }}</NuxtLink>
        <small> ({{ a.date.slice(0, 10) }}, <NuxtLink :to="`/category/${a.category}/`">{{ a.category }}</NuxtLink>)</small>
      </li>
    </ul>
  </div>
</template>
