<script lang="ts">
	import { version } from '$app/environment';
	import { release } from '$lib/release';
</script>

<span
	class="build-version"
	data-testid="build-version"
	data-build={version}
	title={`Loaded build ${version}`}>{release} · {version.slice(0, 7)}</span
>

<style>
	.build-version {
		display: block;
		font-size: 10px;
		line-height: 1.4;
		font-weight: 400;
		letter-spacing: 0;
		color: #a1a1aa;
		overflow-wrap: anywhere;
	}
</style>
