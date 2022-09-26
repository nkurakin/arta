# coding: utf-8

from __future__ import absolute_import

from flask import json
from six import BytesIO

from swagger_server.test import BaseTestCase


class TestArtaController(BaseTestCase):
    """ArtaController integration test stubs"""

    def test_map_new_mode(self):
        """Test case for map_new_mode

        Update an existing mode
        """
        response = self.client.open(
            '/arta/mode/{modeid}'.format(modeid=789),
            method='POST')
        self.assert200(response,
                       'Response body is : ' + response.data.decode('utf-8'))

    def test_map_new_scale(self):
        """Test case for map_new_scale

        Update an existing map scale
        """
        response = self.client.open(
            '/arta/scale/{scaleid}'.format(scaleid=789),
            method='POST')
        self.assert200(response,
                       'Response body is : ' + response.data.decode('utf-8'))

    def test_map_x(self):
        """Test case for map_x

        X point
        """
        response = self.client.open(
            '/arta/x/{x}'.format(x=789),
            method='POST')
        self.assert200(response,
                       'Response body is : ' + response.data.decode('utf-8'))

    def test_map_y(self):
        """Test case for map_y

        Y point
        """
        response = self.client.open(
            '/arta/y/{y}'.format(y=789),
            method='POST')
        self.assert200(response,
                       'Response body is : ' + response.data.decode('utf-8'))

    def test_result(self):
        """Test case for result

        Update an existing mode
        """
        response = self.client.open(
            '/arta',
            method='GET')
        self.assert200(response,
                       'Response body is : ' + response.data.decode('utf-8'))


if __name__ == '__main__':
    import unittest
    unittest.main()
