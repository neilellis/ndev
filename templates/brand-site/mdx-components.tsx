import type { MDXComponents } from "mdx/types";
import { Tokens } from "@/app/components/Tokens";
import { Wordmark, BrandLockup } from "@/app/components/Wordmark";
import { BannedWords, BannedConstructions, BannedSources } from "@/app/components/Banned";
import { Demo, DoDont, Still, StillGrid, Rule } from "@/app/components/Demo";
import {
  Swatch,
  SwatchGrid,
  GradientTile,
  TypeScale,
  SpacingScale,
  RadiusBox,
  ElevationCard,
  ContrastTable,
} from "@/app/components/Specimens";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    Tokens,
    Wordmark,
    BrandLockup,
    BannedWords,
    BannedConstructions,
    BannedSources,
    Demo,
    DoDont,
    Still,
    StillGrid,
    Rule,
    Swatch,
    SwatchGrid,
    GradientTile,
    TypeScale,
    SpacingScale,
    RadiusBox,
    ElevationCard,
    ContrastTable,
    ...components,
  };
}
