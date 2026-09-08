/**
 * @format
 */

import 'react-native';
import React from 'react';
import App from '../App';

// Note: import explicitly to use the types shipped with jest.
import {afterEach, it} from '@jest/globals';

// Note: test renderer must be required after react-native.
import renderer from 'react-test-renderer';

let tree: renderer.ReactTestRenderer | null = null;

afterEach(() => {
  tree?.unmount();
  tree = null;
});

it('renders the server startup screen', () => {
  renderer.act(() => {
    tree = renderer.create(<App />);
  });
  expect(tree.root.findByProps({children: '正在启动 Band Room'})).toBeTruthy();
});
