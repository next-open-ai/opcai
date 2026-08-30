<script setup lang="ts">
import HomeScreen from '../features/home/HomeScreen.vue';
import ThemeSelector from './ThemeSelector.vue';
</script>

<template>
  <header class="app-toolbar"><ThemeSelector /></header>
  <HomeScreen />
</template>
