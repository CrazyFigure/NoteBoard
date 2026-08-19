// NoteBoard 文件图标映射单元测试

import { describe, test, expect } from 'vitest';
import { getExplorerFileIcon } from '@/features/explorer/fileIcons';
import React from 'react';

describe('fileIcons 优雅文件格式图标体系测试', () => {
  test('文件夹返回文件夹图标', () => {
    const closedFolder = getExplorerFileIcon('src', { isDir: true, isOpen: false });
    expect(React.isValidElement(closedFolder)).toBe(true);

    const openFolder = getExplorerFileIcon('src', { isDir: true, isOpen: true });
    expect(React.isValidElement(openFolder)).toBe(true);
  });

  test('图片格式返回对应优雅图标', () => {
    const pngIcon = getExplorerFileIcon('logo.png');
    const jpgIcon = getExplorerFileIcon('photo.jpg');
    const gifIcon = getExplorerFileIcon('anim.gif');
    const webpIcon = getExplorerFileIcon('preview.webp');
    const icoIcon = getExplorerFileIcon('favicon.ico');
    const svgIcon = getExplorerFileIcon('vector.svg');
    const bmpIcon = getExplorerFileIcon('pic.bmp');

    expect(React.isValidElement(pngIcon)).toBe(true);
    expect(React.isValidElement(jpgIcon)).toBe(true);
    expect(React.isValidElement(gifIcon)).toBe(true);
    expect(React.isValidElement(webpIcon)).toBe(true);
    expect(React.isValidElement(icoIcon)).toBe(true);
    expect(React.isValidElement(svgIcon)).toBe(true);
    expect(React.isValidElement(bmpIcon)).toBe(true);
  });

  test('数据与配置文件格式返回专属图标', () => {
    const sqlIcon = getExplorerFileIcon('query.sql');
    const jsonIcon = getExplorerFileIcon('data.json');
    const yamlIcon = getExplorerFileIcon('config.yaml');
    const ymlIcon = getExplorerFileIcon('config.yml');
    const xmlIcon = getExplorerFileIcon('schema.xml');
    const txtIcon = getExplorerFileIcon('notes.txt');
    const mdIcon = getExplorerFileIcon('README.md');
    const boardIcon = getExplorerFileIcon('diagram.board');

    expect(React.isValidElement(sqlIcon)).toBe(true);
    expect(React.isValidElement(jsonIcon)).toBe(true);
    expect(React.isValidElement(yamlIcon)).toBe(true);
    expect(React.isValidElement(ymlIcon)).toBe(true);
    expect(React.isValidElement(xmlIcon)).toBe(true);
    expect(React.isValidElement(txtIcon)).toBe(true);
    expect(React.isValidElement(mdIcon)).toBe(true);
    expect(React.isValidElement(boardIcon)).toBe(true);
  });
});
