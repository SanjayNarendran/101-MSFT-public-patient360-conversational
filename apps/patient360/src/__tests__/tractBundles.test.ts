import { describe, expect, it } from 'vitest';

import { pickBundles, pickMap, type ShowcaseMeta } from '@/chat/tools';

const bundle = (id: string, name: string, group: string, extra: Record<string, unknown> = {}) => {
  const side = id.endsWith('_L') ? 'left' : id.endsWith('_R') ? 'right' : null;
  return {
    id,
    abbr: side ? id.slice(0, -2) : id,
    name,
    side,
    group,
    first: 0,
    lines: 1,
    atlasLines: 1,
    lengthMm: 1,
    zMm: [0, 1] as [number, number],
    yMm: [0, 1] as [number, number],
    colour: '#000000',
    ...extra,
  };
};

const atlas = {
  layers: [
    { id: 'association', label: 'Association fibres', kind: 'tracts' },
    { id: 'projection', label: 'Projection fibres', kind: 'tracts' },
    { id: 'commissural', label: 'Commissural fibres', kind: 'tracts' },
    { id: 'cerebellum', label: 'Cerebellar fibres', kind: 'tracts' },
    { id: 'cranial-nerve', label: 'Cranial nerves', kind: 'tracts' },
  ],
  bundles: [
    bundle('SLF1_L', 'Superior longitudinal fasciculus I', 'association'),
    bundle('SLF2_L', 'Superior longitudinal fasciculus II', 'association', { otherNames: 'dorsal SLF' }),
    bundle('SLF3_L', 'Superior longitudinal fasciculus III', 'association', { otherNames: 'ventral SLF' }),
    bundle('CST_L', 'Corticospinal tract', 'projection', { otherNames: 'pyramidal tract', prob: 'prob/CST_L.nii.gz' }),
    bundle('CST_R', 'Corticospinal tract', 'projection', { otherNames: 'pyramidal tract', prob: 'prob/CST_R.nii.gz' }),
    bundle('CC', 'Corpus callosum', 'commissural', {
      mask: 'mask/CC.nii.gz',
      parts: [
        { id: 'CC_Body', name: 'body', prob: 'prob/CC_Body.nii.gz' },
        { id: 'CC_Forceps_Major', name: 'forceps major', prob: 'prob/CC_Forceps_Major.nii.gz' },
      ],
    }),
    bundle('CB_L', 'Cerebellum', 'cerebellum'),
    bundle('ICP_L', 'Inferior cerebellar peduncle', 'cerebellum'),
    bundle('V', 'Vermis', 'cerebellum'),
    bundle('CNII_L', 'Optic nerve (cranial nerve II)', 'cranial-nerve'),
  ],
} as unknown as ShowcaseMeta;

const pick = (q: string) => pickBundles(atlas, [q], 'The atlas');

describe('the bundles a question names', () => {
  it('takes a group by its id or label before a bundle of the same name', () => {
    expect(pick('cerebellum')).toEqual(['CB_L', 'ICP_L', 'V']);
    expect(pick('cerebellar fibres')).toEqual(['CB_L', 'ICP_L', 'V']);
    expect(pick('cranial nerves')).toEqual(['CNII_L']);
  });

  it('takes a family by its shared abbreviation', () => {
    expect(pick('SLF')).toEqual(['SLF1_L', 'SLF2_L', 'SLF3_L']);
  });

  it('takes names with a side, and other names', () => {
    expect(pick('left corticospinal tract')).toEqual(['CST_L']);
    expect(pick('pyramidal tract')).toEqual(['CST_L', 'CST_R']);
  });

  it('fails on a bundle the atlas does not have', () => {
    expect(() => pick('arcuate fasciculus')).toThrow(/no bundle/);
  });
});

describe('the map a question asks for', () => {
  it('opens a part of the corpus callosum only by its exact name', () => {
    expect(pickMap(atlas, 'forceps major', 'The atlas')).toBe('CC_Forceps_Major');
    expect(pickMap(atlas, 'corpus callosum', 'The atlas')).toBe('CC');
  });

  it('asks for one side', () => {
    expect(() => pickMap(atlas, 'corticospinal tract', 'The atlas')).toThrow(/one side/);
    expect(pickMap(atlas, 'CST_R', 'The atlas')).toBe('CST_R');
  });
});
