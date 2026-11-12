<script setup>
const route = useRoute();
const { data: category } = await useHybldData("category", { slug: route.params.slug });
useHead({ title: `${category.value.name} | Nuxt Demo` });
</script>

<template>
  <div>
    <p><NuxtLink to="/">Nuxt Demo</NuxtLink></p>
    <h1>{{ category.name }}</h1>
    <ul>
      <li v-for="a in category.items" :key="a.slug">
        <NuxtLink :to="`/articles/${a.slug}/`">{{ a.title }}</NuxtLink>
      </li>
    </ul>
  </div>
</template>
