import { create } from 'zustand';
import type { LocationDto } from '../api/types';

interface UsagesState {
  title: string;
  items: LocationDto[];
  loading: boolean;
  set(p: Partial<Pick<UsagesState, 'title' | 'items' | 'loading'>>): void;
}

export const useUsages = create<UsagesState>((set) => ({
  title: '',
  items: [],
  loading: false,
  set: (p) => set(p),
}));
