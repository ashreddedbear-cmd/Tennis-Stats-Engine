import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictionBatchPdfPayload } from './predictions';

test('buildPredictionBatchPdfPayload includes each prediction once and preserves the batch order', () => {
  const predictions = [
    {
      id: 10,
      player1Name: 'Alicia Anisimova',
      player2Name: 'Iga Swiatek',
      predictedWinnerName: 'Iga Swiatek',
      predictedWinnerProbability: 72,
      surface: 'Hard',
      matchFormat: 'BestOf3',
      tournamentName: 'US Open',
      tournamentLevel: 'GrandSlam',
      recommendation: 'HIGH_CONFIDENCE',
      upsetRisk: 'LOW',
      dataQuality: 86,
      predictedSetScore: '2-0',
      engine: { modelAgreement: 'Strong', matchupCloseness: 'Close', models: [{ modelName: 'Surface Elo', weightUsed: 0.7, player1Probability: 73, reliability: 82 }] },
      createdAt: new Date('2026-08-17T10:00:00Z'),
    },
    {
      id: 11,
      player1Name: 'Alicia Anisimova',
      player2Name: 'Iga Swiatek',
      predictedWinnerName: 'Iga Swiatek',
      predictedWinnerProbability: 72,
      surface: 'Hard',
      matchFormat: 'BestOf3',
      tournamentName: 'US Open',
      tournamentLevel: 'GrandSlam',
      recommendation: 'HIGH_CONFIDENCE',
      upsetRisk: 'LOW',
      dataQuality: 86,
      predictedSetScore: '2-0',
      engine: { modelAgreement: 'Strong', matchupCloseness: 'Close', models: [{ modelName: 'Surface Elo', weightUsed: 0.7, player1Probability: 73, reliability: 82 }] },
      createdAt: new Date('2026-08-17T11:00:00Z'),
    },
    {
      id: 11,
      player1Name: 'Alicia Anisimova',
      player2Name: 'Iga Swiatek',
      predictedWinnerName: 'Iga Swiatek',
      predictedWinnerProbability: 72,
      surface: 'Hard',
      matchFormat: 'BestOf3',
      tournamentName: 'US Open',
      tournamentLevel: 'GrandSlam',
      recommendation: 'HIGH_CONFIDENCE',
      upsetRisk: 'LOW',
      dataQuality: 86,
      predictedSetScore: '2-0',
      engine: { modelAgreement: 'Strong', matchupCloseness: 'Close', models: [{ modelName: 'Surface Elo', weightUsed: 0.7, player1Probability: 73, reliability: 82 }] },
      createdAt: new Date('2026-08-17T12:00:00Z'),
    },
  ] as any;

  const payload = buildPredictionBatchPdfPayload(predictions, new Date('2026-08-17T12:30:00Z'));

  assert.equal(payload.predictionCount, 2);
  assert.deepEqual(payload.predictions.map((p) => p.id), [10, 11]);
  assert.match(payload.pdfText, /TENNIS MATRIX AI/);
  assert.match(payload.pdfText, /Alicia Anisimova vs Iga Swiatek/);
  assert.match(payload.pdfText, /Prediction 1 of 2/);
});
