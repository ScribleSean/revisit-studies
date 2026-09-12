import { useState } from 'react';
import { Link } from 'react-router';
import {
  Alert, Badge, Button, Card, Container, Group, Stack, Text, Title,
} from '@mantine/core';
import { GlobalConfig } from '../parser/types';
import { DEMO_STUDIES, loadReviewDemo } from './seedReviewDemo';

export function ReviewDemo({ globalConfig }: { globalConfig: GlobalConfig }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const local = import.meta.env.VITE_STORAGE_ENGINE === 'localStorage';
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const count = await loadReviewDemo(globalConfig);
      setMessage(count ? `Loaded ${count} simulated participants across two studies. Open a review below.` : 'The simulated participants are already loaded. Your edits were preserved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The demo could not be loaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Group justify="space-between">
          <Badge color="orange">Simulated data</Badge>
          <Button component={Link} to="/" variant="subtle">All studies</Button>
        </Group>
        <Title>Explore the ReVIEW rebuild</Title>
        <Text size="lg">Compare fluent, hesitant, and reconsidering examples in two existing studies. Try the timeline, evidence, tags, exports, and cross-recording dashboard.</Text>
        <Alert title="Illustrative examples, not research results" color="orange">These 18 recordings reuse three scripted chart animations. Summaries, events, OCR, and scores are synthetic. They demonstrate the workflow and do not measure model accuracy or researcher time savings.</Alert>
        <Text>Loading adds six labeled participants per study to this browser only. Existing participants and edits are preserved. Nothing is uploaded. Clearing browser site data removes your local work.</Text>
        <Button loading={busy} disabled={!local} onClick={load}>Load simulated recordings</Button>
        {!local && <Alert color="red">Switch to browser local storage to use this demo.</Alert>}
        {error && <Alert color="red" title="Import failed">{error}</Alert>}
        {message && <Alert color="green" role="status">{message}</Alert>}
        {DEMO_STUDIES.map((study) => (
          <Card withBorder key={study.id}>
            <Stack gap="sm">
              <Title order={2} size="h3">{study.name}</Title>
              <Text size="sm">
                Six simulated participants ·
                {study.tasks.length * 6}
                {' '}
                saved recordings
              </Text>
              <Group>
                <Button component={Link} to={`/analysis/stats/${study.id}/recordings`}>Review recordings</Button>
                <Button component={Link} to={`/analysis/stats/${study.id}/cross-recordings`} variant="light">Compare recordings</Button>
                <Button component={Link} to={`/${study.id}`} variant="subtle">Try the actual study</Button>
              </Group>
            </Stack>
          </Card>
        ))}
        <Alert title="What works on GitHub Pages">Saved reviews, playback, timestamp navigation, tags, exports, and dashboard filters work here. New AI analysis, batch analysis, and semantic queries require the local Node/Python service described in the README. GitHub Pages cannot run that service.</Alert>
      </Stack>
    </Container>
  );
}
